//! 导出：HTML（内嵌图片与 KaTeX 字体）、DOCX / LaTeX / EPUB 等文件落盘。
//! PDF / PNG 走 webview_print（WebView2 打印链路）。

use crate::fs_ops::AnyErr;
use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn pstr(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// KaTeX 字体：打包后在 resource_dir/fonts，开发时回退到项目 public/fonts。
pub fn fonts_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    if let Ok(dir) = app.path().resource_dir() {
        let candidate = dir.join("fonts");
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("public")
        .join("fonts");
    dev.is_dir().then_some(dev)
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    }
}

fn normalize_file_ref(raw: &str) -> Option<PathBuf> {
    let clean = raw.split(['?', '#']).next().unwrap_or("");
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("http:") || lower.starts_with("https:") {
        return None;
    }
    let decoded = percent_decode(clean);
    if decoded.starts_with('/') && decoded.as_bytes().get(2) == Some(&b':') {
        return Some(PathBuf::from(decoded[1..].replace('/', "\\")));
    }
    if Path::new(&decoded).is_absolute() {
        return Some(PathBuf::from(decoded.replace('/', "\\")));
    }
    Some(PathBuf::from(decoded))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 导出页自包含：本地图片与 KaTeX woff2 一律内嵌成 data URI。
pub fn materialize_html(html: &str, doc_dir: Option<&str>, fonts: Option<&Path>) -> String {
    let mut out = html.to_string();

    // KaTeX 字体：fonts/X.woff2 / ./fonts/... / dist/fonts/... → data URI
    if let Some(font_dir) = fonts {
        let re = regex::Regex::new(
            r#"url\((['"]?)(?:[^)'"]*?/)?fonts/([^)'"]+?\.woff2)(?:\1)\)|url\((['"]?)(?:\./|\.\./|/)?(?:[^)'"]*?/)?fonts/([^)'"]+?\.woff2)(?:\3)\)"#,
        )
        .unwrap();
        out = re
            .replace_all(&out, |caps: &regex::Captures| {
                let name = caps
                    .get(2)
                    .or_else(|| caps.get(4))
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let file = font_dir.join(&name);
                match fs::read(&file) {
                    Ok(bytes) => format!(
                        "url(data:font/woff2;base64,{})",
                        base64::engine::general_purpose::STANDARD.encode(bytes)
                    ),
                    Err(_) => caps[0].to_string(),
                }
            })
            .into_owned();
    }

    // 图片 src：本地文件内嵌；绝对路径直接读，相对路径按文档目录解析。
    let re = regex::Regex::new(r#"(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)(["'])"#).unwrap();
    out = re
        .replace_all(&out, |caps: &regex::Captures| {
            let whole = caps[0].to_string();
            let prefix = &caps[1];
            let raw = &caps[3];
            let Some(mut file) = normalize_file_ref(raw) else {
                return whole;
            };
            if !file.is_absolute() {
                let Some(dir) = doc_dir else { return whole };
                file = PathBuf::from(dir).join(file);
            }
            match fs::read(&file) {
                Ok(bytes) => format!(
                    "{}\"data:{};base64,{}\"",
                    prefix,
                    mime_of(&file),
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
                Err(_) => whole,
            }
        })
        .into_owned();
    out
}

fn save_dialog(app: &AppHandle, title: &str, filter_name: &str, ext: &str, suggest: &str) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, &[ext])
        .set_file_name(suggest)
        .blocking_save_file()
        .and_then(|f| f.into_path().ok())
}

pub fn export_html_file(
    app: &AppHandle,
    html: &str,
    s: &str,
    doc_dir: Option<&str>,
) -> Result<String, AnyErr> {
    let Some(path) = save_dialog(app, "导出为 HTML", "HTML 文档", "html", s) else {
        return Err("已取消".into());
    };
    let fonts = fonts_dir(app);
    let out = materialize_html(html, doc_dir, fonts.as_deref());
    fs::write(&path, out)?;
    Ok(pstr(&path))
}

pub fn export_docx_file(app: &AppHandle, bytes: &[u8], s: &str) -> Result<String, AnyErr> {
    let Some(path) = save_dialog(app, "导出为 Word", "Word 文档", "docx", s) else {
        return Err("已取消".into());
    };
    fs::write(&path, bytes)?;
    Ok(pstr(&path))
}

#[derive(serde::Deserialize)]
pub struct ExportFilePayload {
    pub bytes: Option<Vec<u8>>,
    pub html: Option<String>,
    pub s: String,
    pub doc_dir: Option<String>,
    pub kind: String,
    /// 自定义扩展名（如设置备份的 json）；不传时沿用 epub/tex 的旧规则。
    #[serde(default)]
    pub ext: Option<String>,
}

pub fn export_generic_file(app: &AppHandle, payload: ExportFilePayload) -> Result<String, AnyErr> {
    let fallback = if payload.kind == "epub" { "epub" } else { "tex" };
    let ext = payload.ext.as_deref().unwrap_or(fallback);
    let Some(path) = save_dialog(app, "导出", &payload.kind, ext, &payload.s) else {
        return Err("已取消".into());
    };
    if let Some(bytes) = payload.bytes {
        fs::write(&path, bytes)?;
    } else {
        let fonts = fonts_dir(app);
        let html = payload.html.unwrap_or_default();
        fs::write(&path, materialize_html(&html, payload.doc_dir.as_deref(), fonts.as_deref()))?;
    }
    Ok(pstr(&path))
}
