//! 图片落盘：粘贴/拖入图片、相对路径素材归集、文档移动时素材跟随、图片删除。
//! 策略与原 Electron 版一致：默认存到文档同级的 assets/，可配置其它相对目录。

use crate::fs_ops::AnyErr;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);
const IMAGE_EXTS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const MAX_IMAGE: usize = 20 * 1024 * 1024;
const DEFAULT_IMAGE_FOLDER: &str = "assets";

#[derive(Serialize)]
pub struct SavedImage {
    pub abs: String,
    pub rel: String,
    pub doc_dir: String,
}

fn pstr(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn safe_image_folder(folder: Option<&str>) -> String {
    let raw = folder.unwrap_or(DEFAULT_IMAGE_FOLDER).trim();
    let clean = raw.trim_matches(['/', '\\']);
    if clean.is_empty()
        || clean == "."
        || clean == ".."
        || clean.split(['/', '\\']).any(|seg| seg == "..")
        || Path::new(clean).is_absolute()
        || clean.contains(':')
    {
        DEFAULT_IMAGE_FOLDER.to_string()
    } else {
        clean.to_string()
    }
}

fn unique_dest(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut dest = dir.join(format!("{base}.{ext}"));
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{base}-{n}.{ext}"));
        n += 1;
    }
    dest
}

fn norm(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}

fn inside_fs_path(root: &Path, target: &Path) -> bool {
    let r = norm(&pstr(root));
    let t = norm(&pstr(target));
    let sep = std::path::MAIN_SEPARATOR;
    !r.is_empty() && (t == r || t.starts_with(&format!("{r}{sep}")))
}

fn decode_image_source(doc_dir: &Path, source: &str) -> Option<PathBuf> {
    if source.contains('%') {
        // asset protocol 会把路径百分号编码
        let decoded = percent_decode(source);
        return decode_plain(doc_dir, &decoded);
    }
    decode_plain(doc_dir, source)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
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

fn decode_plain(doc_dir: &Path, source: &str) -> Option<PathBuf> {
    let clean = source.split(['?', '#']).next().unwrap_or("");
    if clean.is_empty() {
        return None;
    }
    let lower = clean.to_ascii_lowercase();
    if lower.starts_with("file://") {
        let mut p = clean[7..].replace('/', "\\");
        if p.len() > 2 && p.starts_with('\\') && p.as_bytes().get(2) == Some(&b':') {
            p.remove(0);
        }
        return Some(PathBuf::from(p));
    }
    // Tauri asset protocol：Windows 为 http://asset.localhost/<编码路径>
    for prefix in ["http://asset.localhost/", "https://asset.localhost/", "asset://localhost/"] {
        if lower.starts_with(prefix) {
            let rest = &clean[prefix.len()..];
            return Some(PathBuf::from(percent_decode(rest).replace('/', "\\")));
        }
    }
    if Path::new(clean).is_absolute() {
        return Some(PathBuf::from(clean));
    }
    if lower.starts_with("data:") || lower.starts_with("http:") || lower.starts_with("https:") {
        return None;
    }
    Some(doc_dir.join(clean))
}

fn relative_to(doc_dir: &Path, target: &Path) -> String {
    let dd = doc_dir
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let tt = target
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    let mut i = 0;
    while i < dd.len() && i < tt.len() && dd[i].eq_ignore_ascii_case(&tt[i]) {
        i += 1;
    }
    let mut parts = vec!["..".to_string(); dd.len() - i];
    parts.extend(tt[i..].iter().cloned());
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

fn finalize_image(dest: &Path, doc_dir: &Path) -> SavedImage {
    let abs = pstr(dest);
    SavedImage {
        rel: relative_to(doc_dir, dest).replace('\\', "/"),
        abs: abs.clone(),
        doc_dir: pstr(doc_dir),
    }
}

/// 图片统一放「落盘时那一刻的文档目录」下：未命名文档先落到临时目录，首次保存时再归集。
pub fn save_image_bytes(
    buf: &[u8],
    ext: &str,
    doc_path: Option<&str>,
    folder: Option<&str>,
) -> Result<SavedImage, AnyErr> {
    if buf.is_empty() || buf.len() > MAX_IMAGE {
        return Err("图片为空或超过 20MiB 上限".into());
    }
    let ext = ext.to_ascii_lowercase();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err("不支持的图片格式".into());
    }
    let doc = doc_path.filter(|p| !p.is_empty()).map(PathBuf::from);
    let doc_dir = doc
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .filter(|d| d.is_absolute());
    let base_dir = doc_dir.unwrap_or_else(|| std::env::temp_dir().join("plume-paste"));
    let dir = base_dir.join(safe_image_folder(folder));
    fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let seq = IMAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let dest = unique_dest(&dir, &format!("image-{stamp}-{seq}"), &ext);
    fs::write(&dest, buf)?;
    let actual_doc_dir = doc
        .as_ref()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .filter(|d| d.is_absolute())
        .unwrap_or(base_dir);
    Ok(finalize_image(&dest, &actual_doc_dir))
}

pub fn adopt_image(
    abs_path: &str,
    doc_path: &str,
    folder: Option<&str>,
) -> Result<SavedImage, AnyErr> {
    let src = PathBuf::from(abs_path);
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !src.is_file() || !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err("不是支持的图片文件".into());
    }
    if fs::metadata(&src)?.len() as usize > MAX_IMAGE {
        return Err("图片超过 20MiB 上限".into());
    }
    let doc = PathBuf::from(doc_path);
    let doc_dir = doc
        .parent()
        .filter(|d| d.is_absolute())
        .map(Path::to_path_buf)
        .ok_or("未保存的文档不能收纳绝对路径图片")?;
    let dir = doc_dir.join(safe_image_folder(folder));
    fs::create_dir_all(&dir)?;
    let dest = unique_dest(&dir, src.file_stem().unwrap().to_string_lossy().as_ref(), &ext);
    fs::copy(&src, &dest)?;
    Ok(finalize_image(&dest, &doc_dir))
}

/// 整理：相对路径的本地图片收进 assets/，正文里的引用由前端按 rel 重写。
pub fn collect_images(
    sources: Vec<String>,
    doc_path: &str,
    folder: Option<&str>,
) -> Result<HashMap<String, SavedImage>, AnyErr> {
    let doc = PathBuf::from(doc_path);
    let doc_dir = doc.parent().map(Path::to_path_buf).ok_or("未命名文档")?;
    let dir = doc_dir.join(safe_image_folder(folder));
    let mut out = HashMap::new();
    for source in sources {
        let Some(src) = decode_image_source(&doc_dir, &source) else {
            continue;
        };
        if !src.is_file() {
            continue;
        }
        if !inside_fs_path(&doc_dir, &src) {
            continue;
        }
        if fs::metadata(&src)?.len() as usize > MAX_IMAGE {
            continue;
        }
        // 已经在归集目录里的不动，避免每次保存都复制一遍
        if inside_fs_path(&dir, &src) {
            continue;
        }
        fs::create_dir_all(&dir)?;
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        let dest = unique_dest(&dir, src.file_stem().unwrap().to_string_lossy().as_ref(), &ext);
        fs::copy(&src, &dest)?;
        out.insert(source, finalize_image(&dest, &doc_dir));
    }
    Ok(out)
}

/// 移动：相对图片随文档搬入新目录的 assets/。
pub fn move_images(
    sources: Vec<String>,
    doc_path: &str,
    folder: Option<&str>,
) -> Result<HashMap<String, SavedImage>, AnyErr> {
    let doc = PathBuf::from(doc_path);
    let doc_dir = doc.parent().map(Path::to_path_buf).ok_or("未命名文档")?;
    let dir = doc_dir.join(safe_image_folder(folder));
    let mut out = HashMap::new();
    for source in sources {
        let Some(src) = decode_image_source(&doc_dir, &source) else {
            continue;
        };
        if !src.is_file() || !inside_fs_path(&doc_dir, &src) {
            continue;
        }
        if fs::metadata(&src)?.len() as usize > MAX_IMAGE {
            continue;
        }
        if inside_fs_path(&dir, &src) {
            continue;
        }
        fs::create_dir_all(&dir)?;
        let ext = src.extension().unwrap_or_default().to_string_lossy();
        let dest = unique_dest(&dir, src.file_stem().unwrap().to_string_lossy().as_ref(), &ext);
        fs::rename(&src, &dest)?;
        out.insert(source, finalize_image(&dest, &doc_dir));
    }
    Ok(out)
}

/// 删除图片：相对/绝对引用都可以，但一律不许动文档目录之外的文件；
/// 空目录自底向上清，停在文档根。
pub fn trash_image(source: &str, doc_path: &str) -> Result<(), AnyErr> {
    let doc = PathBuf::from(doc_path);
    let doc_dir = doc
        .parent()
        .filter(|d| d.is_absolute())
        .map(Path::to_path_buf)
        .ok_or("未保存的文档不能删除图片")?;
    let src = decode_image_source(&doc_dir, source).ok_or("非法图片路径")?;
    if !src.is_file() || !inside_fs_path(&doc_dir, &src) {
        return Err("只允许删除本文档目录内的本地图片".into());
    }
    let canonical_dir = doc_dir.canonicalize().unwrap_or(doc_dir.clone());
    let canonical_src = src.canonicalize().unwrap_or(src.clone());
    if !inside_fs_path(&canonical_dir, &canonical_src) {
        return Err("图片路径越出文档目录".into());
    }
    trash::delete(&src).map_err(|e| -> AnyErr { format!("移入回收站失败：{e}").into() })?;
    let mut dir = src.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if !inside_fs_path(&doc_dir, &d) || d == doc_dir {
            break;
        }
        match fs::read_dir(&d) {
            Ok(entries) => {
                if entries.count() == 0 {
                    let _ = fs::remove_dir(&d);
                    dir = d.parent().map(Path::to_path_buf);
                } else {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    Ok(())
}
