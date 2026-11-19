//! Windows 打印链路：隐藏 WebView2 加载导出页 → PrintToPdf / CapturePreview。
//! 这是 Tauri 没有 `webContents.printToPDF` 等价物后的替代实现，仅 Windows。
//!
//! 自定义 `export://` 协议承载一次性 HTML；COM 回调用 webview2-com 自带的
//! completed handler 封装 + 手工消息泵等待，避免阻塞 STA 线程导致回调无法派发。

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, WebviewUrl, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CapturePreviewCompletedHandler, ExecuteScriptCompletedHandler, PrintToPdfCompletedHandler,
};
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::IStream;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
};

use crate::fs_ops::AnyErr;

static PAGES: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

pub fn pages() -> &'static Mutex<HashMap<String, String>> {
    PAGES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// STA 消息泵：等 COM 回调时继续派发消息，否则回调进不来。
fn pump_until<T>(rx: &Receiver<T>, timeout: Duration) -> Option<T> {
    let start = Instant::now();
    loop {
        if let Ok(v) = rx.try_recv() {
            return Some(v);
        }
        if start.elapsed() > timeout {
            return None;
        }
        unsafe {
            let mut msg = MSG::default();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn wait(ms: u64) {
    pump_until(&channel::<()>().1, Duration::from_millis(ms));
}

fn build_export_window(app: &AppHandle, html: &str) -> Result<(WebviewWindow, String), AnyErr> {
    let key = format!(
        "page-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    pages()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(key.clone(), html.to_string());
    let url = format!("http://export.localhost/{key}");
    let label = format!("export-{}", key);
    let window = tauri::WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.parse()?))
        .title("Plume 导出")
        .inner_size(900.0, 1200.0)
        .visible(false)
        .build()?;
    Ok((window, key))
}

fn finish_export(window: &WebviewWindow, key: &str) {
    let _ = window.close();
    if let Ok(mut map) = pages().lock() {
        map.remove(key);
    }
}

fn make_webview_visible(window: &WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            let _ = webview.controller().SetIsVisible(true);
            let _ = core;
        }
    });
}

/// 导出 PDF：A4、四边距 0.4in、保留背景色，与原 Electron printToPDF 参数一致。
pub fn print_to_pdf(app: &AppHandle, html: &str, out: &Path) -> Result<(), AnyErr> {
    let (window, key) = build_export_window(app, html)?;
    make_webview_visible(&window);
    // 等页面与 KaTeX/Mermaid 渲染（本地资源，固定等待）
    wait(1800);

    let (tx, rx) = channel::<bool>();
    let out_wide = wide(&out.to_string_lossy());
    window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let Ok(core7) = core.cast::<ICoreWebView2_7>() else {
            return;
        };
        let settings = core
            .cast::<ICoreWebView2_2>()
            .ok()
            .and_then(|c2| c2.Environment().ok())
            .and_then(|env| env.cast::<ICoreWebView2Environment6>().ok())
            .and_then(|env| env.CreatePrintSettings().ok());
        if let Some(settings) = &settings {
            let _ = settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
            let _ = settings.SetScaleFactor(1.0);
            let _ = settings.SetPageWidth(8.27);
            let _ = settings.SetPageHeight(11.69);
            let _ = settings.SetMarginTop(0.4);
            let _ = settings.SetMarginBottom(0.4);
            let _ = settings.SetMarginLeft(0.4);
            let _ = settings.SetMarginRight(0.4);
            let _ = settings.SetShouldPrintBackgrounds(true);
            let _ = settings.SetShouldPrintHeaderAndFooter(false);
        }
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, success| {
            let _ = tx.send(result.is_ok() && success);
            Ok(())
        }));
        let _ = core7.PrintToPdf(PCWSTR(out_wide.as_ptr()), settings.as_ref(), &handler);
    })?;
    let ok = pump_until(&rx, Duration::from_secs(90)).unwrap_or(false);
    finish_export(&window, &key);
    if ok {
        Ok(())
    } else {
        Err("WebView2 生成 PDF 失败".into())
    }
}

/// 导出长图：先量 scrollHeight，把离屏窗口撑到全文高（上限 14000px），再一次 CapturePreview。
pub fn capture_png(app: &AppHandle, html: &str, out: &Path) -> Result<(), AnyErr> {
    let (window, key) = build_export_window(app, html)?;
    make_webview_visible(&window);
    wait(1800);

    let (tx_h, rx_h) = channel::<String>();
    window.with_webview(move |webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
                let _ = tx_h.send(if result.is_ok() { json } else { String::new() });
                Ok(())
            }));
            let _ = core.ExecuteScript(
                PCWSTR(wide("document.documentElement.scrollHeight").as_ptr()),
                &handler,
            );
        }
    })?;
    let height = pump_until(&rx_h, Duration::from_secs(10))
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(1200.0)
        .clamp(600.0, 14000.0);
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: 900,
        height: height as u32,
    }))?;
    wait(300);

    let (tx, rx) = channel::<bool>();
    let stream: IStream = unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true)? };
    // with_webview 闭包要求 Send：传裸指针，闭包内临时包装后 forget，
    // 释放仍由外层 stream 负责，避免双重 Release。
    let raw = Interface::as_raw(&stream) as usize;
    window.with_webview(move |webview| unsafe {
        if let Ok(core) = webview.controller().CoreWebView2() {
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let _ = tx.send(result.is_ok());
                Ok(())
            }));
            let stream_for_cb = IStream::from_raw(raw as *mut core::ffi::c_void);
            let _ = core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream_for_cb,
                &handler,
            );
            std::mem::forget(stream_for_cb);
        }
    })?;
    let ok = pump_until(&rx, Duration::from_secs(60)).unwrap_or(false);
    finish_export(&window, &key);
    if !ok {
        return Err("WebView2 截图失败".into());
    }

    let mut data = Vec::new();
    let mut buf = [0u8; 16384];
    unsafe {
        loop {
            let mut read = 0u32;
            let hr = stream.Read(
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                Some(&mut read),
            );
            if hr.is_err() || read == 0 {
                break;
            }
            data.extend_from_slice(&buf[..read as usize]);
        }
    }
    if data.is_empty() {
        return Err("截图为空".into());
    }
    std::fs::write(out, data)?;
    Ok(())
}
