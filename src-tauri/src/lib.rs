//! Plume：Tauri 宿主层。前端（Vue + CM6）通过 window.studio 调到这里，
//! 所有文件系统、目录监听、系统对话框与导出能力都在 Rust 侧。

mod exports;
mod fs_ops;
mod images;
mod watch;
#[cfg(target_os = "windows")]
mod webview_print;

use fs_ops::AnyErr;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct DirtyState(AtomicBool);

fn cmd_err(e: AnyErr) -> String {
    e.to_string()
}

/* ---------------- 应用信息 / 主题 ---------------- */

#[derive(Serialize)]
struct AppInfo {
    version: String,
    platform: String,
    tauri: String,
    user_theme_dir: String,
}

fn user_theme_dir(app: &AppHandle) -> Result<PathBuf, AnyErr> {
    let dir = app.path().app_config_dir()?.join("themes");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    let dir = user_theme_dir(&app).map_err(cmd_err)?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        tauri: "2".to_string(),
        user_theme_dir: dir.to_string_lossy().to_string(),
    })
}

const BASE_TEMPLATE: &str = r#"/* Plume 用户自定义 CSS
 * 只影响编辑器外观，不动交互逻辑。
 * 保存后回编辑器按「应用 CSS」生效。
 * 示例：
 * :root { --text: #1f2937; --accent: #7c3aed; }
 * .cm-content { font-size: 17px; }
 */
"#;

#[tauri::command]
fn theme_paths(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let dir = user_theme_dir(&app).map_err(cmd_err)?;
    let mut out = HashMap::new();
    let base = dir.join("base.css");
    if !base.exists() {
        let _ = std::fs::write(&base, BASE_TEMPLATE);
    }
    out.insert("base".to_string(), base.to_string_lossy().to_string());
    for name in ["white", "night", "glass", "aurora", "paper", "solar", "neon", "chalk"] {
        let f = dir.join(format!("{name}.css"));
        if !f.exists() {
            let _ = std::fs::write(
                &f,
                format!("/* Plume 用户主题：{name}\n * 覆盖编辑器主题变量即可。\n */\n"),
            );
        }
        out.insert(name.to_string(), f.to_string_lossy().to_string());
    }
    Ok(out)
}

#[tauri::command]
fn theme_open_folder(app: AppHandle) -> Result<bool, String> {
    let dir = user_theme_dir(&app).map_err(cmd_err)?;
    opener::open(&dir).map_err(|e| e.to_string())?;
    Ok(true)
}

/* ---------------- 文档读写 ---------------- */

#[tauri::command]
fn file_open(app: AppHandle) -> Result<Option<fs_ops::Doc>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .add_filter("所有文件", &["*"])
        .blocking_pick_file();
    match file {
        Some(f) => {
            let path = f.into_path().map_err(|e| e.to_string())?;
            fs_ops::read_doc(&path.to_string_lossy())
                .map(Some)
                .map_err(cmd_err)
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn file_read(p: String) -> Result<fs_ops::Doc, String> {
    fs_ops::read_doc(&p).map_err(cmd_err)
}

/// 设置导入：挑一个 JSON 文件并读回文本（设置备份统一 UTF-8）。
#[tauri::command]
fn settings_import_pick(app: AppHandle) -> Result<Option<String>, String> {
    let file = app
        .dialog()
        .file()
        .add_filter("Plume 设置", &["json"])
        .blocking_pick_file();
    match file {
        Some(f) => {
            let path = f.into_path().map_err(|e| e.to_string())?;
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            String::from_utf8(bytes)
                .map(Some)
                .map_err(|_| "设置文件不是有效的 UTF-8 文本".to_string())
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn file_read_bytes(p: String) -> Result<Vec<u8>, String> {
    std::fs::read(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn file_save(app: AppHandle, p: String, c: String, enc: Option<String>) -> Result<String, String> {
    // 按读取时判定的原编码写回（缺省 UTF-8）；无法表示的字符报错而不是静默替换。
    let bytes = fs_ops::encode_for_save(&c, enc.as_deref().unwrap_or("utf-8")).map_err(cmd_err)?;
    let out = fs_ops::write_bytes_atomic(&p, &bytes).map_err(cmd_err)?;
    // 登记自写指纹，目录监听据此过滤自己保存产生的事件，避免误报外部修改。
    watch::note_self_write(&app, &p);
    Ok(out)
}

#[tauri::command]
fn file_save_as(app: AppHandle, c: String, s: Option<String>) -> Result<Option<String>, String> {
    // 新文档从未保存过时前端没有路径可传，s 会缺省；缺省必须给默认文件名，
    // 否则「另存为」直接以 invalid args 报错（发布后被最多人踩到的路径）。
    let name = s
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("未命名.md");
    let file = app
        .dialog()
        .file()
        .set_title("另存为")
        .add_filter("Markdown", &["md", "markdown"])
        .set_file_name(name)
        .blocking_save_file();
    match file {
        Some(f) => {
            let path = f.into_path().map_err(|e| e.to_string())?;
            // 另存为新文件统一写 UTF-8（前端随后也会把文档编码标记重置为 utf-8）。
            let out = fs_ops::write_text_atomic(&path.to_string_lossy(), &c).map_err(cmd_err)?;
            watch::note_self_write(&app, &out);
            Ok(Some(out))
        }
        None => Ok(None),
    }
}

/* ---------------- 文件树 / 搜索 / 监听 ---------------- */

// 目录列举与跨文件搜索是重 IO：放到阻塞线程池执行，避免卡住主线程上的 UI 事件。
#[tauri::command]
async fn fs_list(d: String) -> Result<Vec<fs_ops::Entry>, String> {
    tauri::async_runtime::spawn_blocking(move || fs_ops::list_dir(&d))
        .await
        .map_err(|e| e.to_string())?
        .map_err(cmd_err)
}

#[tauri::command]
async fn fs_search(
    dir: String,
    query: String,
    opts: Option<fs_ops::SearchOpts>,
) -> Result<fs_ops::SearchOutcome, String> {
    let opts = opts.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || fs_ops::search_files(&dir, &query, opts))
        .await
        .map_err(|e| e.to_string())?
        .map_err(cmd_err)
}

#[tauri::command]
fn fs_create(root: String, dir: String, name: String, directory: bool) -> Result<String, String> {
    fs_ops::create_entry(&root, &dir, &name, directory).map_err(cmd_err)
}

#[tauri::command]
fn fs_rename(root: String, source: String, name: String) -> Result<String, String> {
    fs_ops::rename_entry(&root, &source, &name).map_err(cmd_err)
}

#[tauri::command]
fn fs_trash(root: String, source: String) -> Result<bool, String> {
    fs_ops::trash_entry(&root, &source).map_err(cmd_err)?;
    Ok(true)
}

#[tauri::command]
fn fs_move(root: String, source: String, dest_dir: String) -> Result<String, String> {
    fs_ops::move_entry(&root, &source, &dest_dir).map_err(cmd_err)
}

#[tauri::command]
fn fs_show(root: String, source: String) -> Result<bool, String> {
    fs_ops::show_entry(&root, &source).map_err(cmd_err)?;
    Ok(true)
}

#[tauri::command]
fn doc_watch(app: AppHandle, p: Option<String>) -> Result<(), String> {
    watch::watch_document(&app, p)
}

/* ---------------- 图片 ---------------- */

#[tauri::command]
fn image_save(
    buf: Vec<u8>,
    ext: String,
    doc_path: Option<String>,
    folder: Option<String>,
) -> Result<images::SavedImage, String> {
    images::save_image_bytes(&buf, &ext, doc_path.as_deref(), folder.as_deref()).map_err(cmd_err)
}

#[tauri::command]
fn image_adopt(
    abs_path: String,
    doc_path: String,
    folder: Option<String>,
) -> Result<images::SavedImage, String> {
    images::adopt_image(&abs_path, &doc_path, folder.as_deref()).map_err(cmd_err)
}

#[tauri::command]
fn image_collect(
    sources: Vec<String>,
    doc_path: String,
    folder: Option<String>,
) -> Result<HashMap<String, images::SavedImage>, String> {
    images::collect_images(sources, &doc_path, folder.as_deref()).map_err(cmd_err)
}

#[tauri::command]
fn image_move(
    sources: Vec<String>,
    doc_path: String,
    folder: Option<String>,
) -> Result<HashMap<String, images::SavedImage>, String> {
    images::move_images(sources, &doc_path, folder.as_deref()).map_err(cmd_err)
}

#[tauri::command]
fn image_trash(source: String, doc_path: String) -> Result<bool, String> {
    images::trash_image(&source, &doc_path).map_err(cmd_err)?;
    Ok(true)
}

/* ---------------- 导出 ---------------- */

#[tauri::command]
fn export_html(app: AppHandle, html: String, s: String, doc_dir: Option<String>) -> Result<String, String> {
    exports::export_html_file(&app, &html, &s, doc_dir.as_deref()).map_err(cmd_err)
}

#[tauri::command]
fn export_pdf(app: AppHandle, html: String, s: String, doc_dir: Option<String>) -> Result<String, String> {
    let path = app
        .dialog()
        .file()
        .set_title("导出为 PDF")
        .add_filter("PDF 文档", &["pdf"])
        .set_file_name(s)
        .blocking_save_file();
    let Some(f) = path else { return Err("已取消".into()) };
    let out = f.into_path().map_err(|e| e.to_string())?;
    let fonts = exports::fonts_dir(&app);
    let page = exports::materialize_html(&html, doc_dir.as_deref(), fonts.as_deref());
    #[cfg(target_os = "windows")]
    {
        webview_print::print_to_pdf(&app, &page, &out).map_err(cmd_err)?;
        Ok(out.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (page, out);
        Err("当前平台尚未实现 PDF 导出".into())
    }
}

#[tauri::command]
fn export_png(app: AppHandle, html: String, s: String, doc_dir: Option<String>) -> Result<String, String> {
    let path = app
        .dialog()
        .file()
        .set_title("导出为图片")
        .add_filter("PNG 图片", &["png"])
        .set_file_name(s)
        .blocking_save_file();
    let Some(f) = path else { return Err("已取消".into()) };
    let out = f.into_path().map_err(|e| e.to_string())?;
    let fonts = exports::fonts_dir(&app);
    let page = exports::materialize_html(&html, doc_dir.as_deref(), fonts.as_deref());
    #[cfg(target_os = "windows")]
    {
        webview_print::capture_png(&app, &page, &out).map_err(cmd_err)?;
        Ok(out.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (page, out);
        Err("当前平台尚未实现 PNG 导出".into())
    }
}

#[tauri::command]
fn export_docx(app: AppHandle, bytes: Vec<u8>, s: String) -> Result<String, String> {
    exports::export_docx_file(&app, &bytes, &s).map_err(cmd_err)
}

#[tauri::command]
fn export_file(app: AppHandle, payload: exports::ExportFilePayload) -> Result<String, String> {
    exports::export_generic_file(&app, payload).map_err(cmd_err)
}

/* ---------------- 系统对话框 ---------------- */

#[tauri::command]
fn dialog_confirm(app: AppHandle, m: String) -> Result<bool, String> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    Ok(app
        .dialog()
        .message(m)
        .title("确认")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show())
}

#[tauri::command]
fn dialog_unsaved(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    // Yes = 保存，No = 不保存，Cancel = 取消
    let save = app
        .dialog()
        .message("当前文档有未保存的修改。\n选择「是」保存后关闭，「否」放弃修改。")
        .title("Plume")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancel)
        .blocking_show();
    Ok(if save { "save" } else { "discard" }.to_string())
}

#[derive(serde::Deserialize)]
struct InfoPayload {
    title: Option<String>,
    message: String,
    detail: Option<String>,
}

#[tauri::command]
fn dialog_info(app: AppHandle, payload: InfoPayload) -> Result<bool, String> {
    let text = match payload.detail {
        Some(d) if !d.is_empty() => format!("{}\n\n{}", payload.message, d),
        _ => payload.message,
    };
    app.dialog()
        .message(text)
        .title(payload.title.unwrap_or_else(|| "Plume".to_string()))
        .blocking_show();
    Ok(true)
}

/* ---------------- 窗口状态 ---------------- */

#[tauri::command]
fn state_dirty(app: AppHandle, v: bool) -> Result<bool, String> {
    app.state::<DirtyState>().0.store(v, Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
fn state_title(app: AppHandle, t: String) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&t);
    }
    Ok(true)
}

#[tauri::command]
fn chrome_theme(_app: AppHandle, _c: String) -> Result<bool, String> {
    // 外壳配色由前端 CSS 变量负责（含自绘三键），这里仅保持 API 兼容。
    Ok(true)
}

#[tauri::command]
fn app_quit(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn shell_open_external(u: String) -> Result<bool, String> {
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("只允许打开 http(s) 或 mailto 链接".into());
    }
    opener::open(&u).map_err(|e| e.to_string())?;
    Ok(true)
}

/* ---------------- 启动 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 从命令行参数里挑出要打开的文档（文件关联「打开方式」/双击 .md 时由系统传入）。
fn file_arg(args: &[String]) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        let p = std::path::PathBuf::from(a.trim_matches('"'));
        if p.is_file() {
            Some(p.to_string_lossy().to_string())
        } else {
            None
        }
    })
}

/// 冷启动时待打开的文档，前端初始化完成后通过 take_initial_file 取走（只取一次）。
struct InitialFile(std::sync::Mutex<Option<String>>);

#[tauri::command]
fn take_initial_file(state: tauri::State<'_, InitialFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("PANIC: {info}\n");
        eprintln!("{msg}");
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            let log = std::path::PathBuf::from(dir).join("com.plume.app").join("plume-panic.log");
            let _ = std::fs::create_dir_all(log.parent().unwrap());
            let _ = std::fs::write(log, msg);
        }
    }));
    tauri::Builder::default()
        // 单实例：应用已运行时，再次通过「打开方式」/双击文档不会新开窗口，
        // 而是把路径发给已运行的实例，由前端在同一窗口打开。
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = file_arg(&args) {
                let _ = app.emit("plume:open-file", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 应用内更新：检查 / 下载 / 安装走 GitHub Releases 的 latest.json，
        // 签名公钥在 tauri.conf.json 的 plugins.updater 里；process 用于装完后重启。
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(InitialFile(std::sync::Mutex::new(file_arg(
            &std::env::args().collect::<Vec<_>>(),
        ))))
        .manage(DirtyState::default())
        .manage(watch::WatchState::default())
        .register_uri_scheme_protocol("export", |_ctx, request| {
            let key = request.uri().path().trim_start_matches('/').to_string();
            #[cfg(target_os = "windows")]
            let body = webview_print::pages()
                .lock()
                .ok()
                .and_then(|map| map.get(&key).cloned())
                .unwrap_or_default();
            #[cfg(not(target_os = "windows"))]
            let body = String::new();
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(body.into_bytes())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            theme_paths,
            theme_open_folder,
            file_open,
            file_read,
            file_read_bytes,
            settings_import_pick,
            file_save,
            file_save_as,
            fs_list,
            fs_search,
            fs_create,
            fs_rename,
            fs_trash,
            fs_move,
            fs_show,
            doc_watch,
            image_save,
            image_adopt,
            image_collect,
            image_move,
            image_trash,
            export_html,
            export_pdf,
            export_png,
            export_docx,
            export_file,
            dialog_confirm,
            dialog_unsaved,
            dialog_info,
            state_dirty,
            state_title,
            chrome_theme,
            app_quit,
            shell_open_external,
            take_initial_file,
        ])
        .setup(|app| {
            println!("[plume] setup");
            if let Some(w) = app.get_webview_window("main") {
                println!("[plume] main visible={:?}", w.is_visible());
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(())
        })
        // 关闭请求先拦下交给前端：有未保存文档时弹应用内三态面板，
        // 前端确认后调用 app_quit 真正退出。
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.emit("plume:close-requested", ());
                    }
                }
                // Windows 上快速调整窗口/拖动边缘时，WebView2 的视口偶尔没有跟上窗口，
                // 表现为状态栏上移、窗口底部多出一条空白。这里在尺寸变化时显式同步一次，
                // 让 WebView 的 bounds 始终等于当前窗口客户区。
                tauri::WindowEvent::Resized(size) => {
                    if window.label() == "main" {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let logical = size.to_logical::<f64>(scale);
                        for webview in window.webviews() {
                            let _ = webview.set_size(tauri::LogicalSize::new(
                                logical.width,
                                logical.height,
                            ));
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Plume");
}
