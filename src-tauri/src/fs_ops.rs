//! 文件系统服务：文档读写（原子保存）、目录列举、跨文件搜索、文件树操作。
//! 规则与原 Electron 主进程保持一致：文件树只列子目录与 .md/.markdown/.txt，
//! 隐藏文件与 node_modules 跳过，每层最多 300 条；搜索单文件 10 条、共 200 条、>1MiB 跳过。

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const DOC_EXTS: [&str; 3] = ["md", "markdown", "txt"];
const MAX_LIST: usize = 300;
const MAX_HITS_TOTAL: usize = 200;
const MAX_HITS_PER_FILE: usize = 10;
const SEARCHABLE_MAX: u64 = 1024 * 1024;

pub type AnyErr = Box<dyn std::error::Error + Send + Sync>;

#[derive(Serialize)]
pub struct Doc {
    pub path: String,
    pub content: String,
    pub dir: Option<String>,
    /// 读取时判定/检测出的编码标签（utf-8、gbk、big5、utf-16le…），保存时按它写回。
    pub encoding: String,
}

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub dir: bool,
    pub name: String,
    pub mtime: u128,
    pub size: u64,
    pub snippet: String,
}

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub name: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
}

/// 跨文件搜索选项（前端 camelCase 传入）。
#[derive(serde::Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchOpts {
    pub match_case: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Serialize)]
pub struct SearchOutcome {
    pub hits: Vec<Hit>,
    /// 达到总条数上限提前停止：可能还有更多结果，前端应提示用户细化关键词。
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files_changed: usize,
    pub replacements: usize,
    pub changed_paths: Vec<String>,
}

fn build_matcher(query: &str, opts: &SearchOpts) -> Result<regex::Regex, AnyErr> {
    let mut pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if opts.whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.match_case)
        .build()
        .map_err(|e| format!("搜索模式无效：{}", e).into())
}

fn pstr(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// 解码文件字节：优先按 UTF-8；失败时用 chardetng 检测（GBK/Big5/UTF-16 等）。
/// 返回 (文本, 编码标签)。BOM 由 encoding_rs 的 decode 做嗅探剥离，UTF-8 BOM 留给前端处理。
fn decode_text(bytes: &[u8]) -> (String, String) {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return (s.to_string(), "utf-8".to_string());
    }
    // chardetng 只识别 8 位传统编码，UTF-16 必须先按 BOM 嗅探，
    // 否则标签判错、保存时会按错误编码写回。decode 自身会剥离 BOM。
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return (text.into_owned(), "utf-16le".to_string());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return (text.into_owned(), "utf-16be".to_string());
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (text, _, _) = enc.decode(bytes);
    (text.into_owned(), enc.name().to_ascii_lowercase())
}

/// 按原编码编码待保存文本。UTF-16 手动补 BOM；出现目标编码无法表示的字符时报错，
/// 提示用户另存为 UTF-8 副本，而不是静默替换成问号。
pub fn encode_for_save(content: &str, encoding: &str) -> Result<Vec<u8>, AnyErr> {
    let label = encoding.trim().to_ascii_lowercase();
    if label.is_empty() || label == "utf-8" || label == "utf8" {
        return Ok(content.as_bytes().to_vec());
    }
    let enc = encoding_rs::Encoding::for_label(label.as_bytes())
        .ok_or_else(|| -> AnyErr { format!("未知编码：{encoding}").into() })?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let le = enc == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(content.len() * 2 + 2);
        out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        for unit in content.encode_utf16() {
            let bytes = if le { unit.to_le_bytes() } else { unit.to_be_bytes() };
            out.extend_from_slice(&bytes);
        }
        return Ok(out);
    }
    let (bytes, _, unmappable) = enc.encode(content);
    if unmappable {
        return Err(format!(
            "包含 {} 编码无法表示的字符，请用「另存为」保存为 UTF-8 副本",
            enc.name()
        )
        .into());
    }
    Ok(bytes.into_owned())
}

pub fn read_doc(p: &str) -> Result<Doc, AnyErr> {
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err("非法路径".into());
    }
    let bytes = fs::read(&path)?;
    let (content, encoding) = decode_text(&bytes);
    let dir = path.parent().map(pstr).filter(|s| !s.is_empty());
    Ok(Doc {
        path: pstr(&path),
        content,
        dir,
        encoding,
    })
}

/// 原子保存：同目录临时文件 → fsync → rename（Windows 下 rename 覆盖已存在目标）。
pub fn write_text_atomic(p: &str, content: &str) -> Result<String, AnyErr> {
    write_bytes_atomic(p, content.as_bytes())
}

pub fn write_bytes_atomic(p: &str, bytes: &[u8]) -> Result<String, AnyErr> {
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err("非法路径".into());
    }
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or("没有父目录")?;
    fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .ok_or("没有文件名")?
        .to_string_lossy()
        .to_string();
    let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file_name,
        std::process::id(),
        stamp
    ));
    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    match fs::rename(&tmp, &path) {
        Ok(()) => Ok(pstr(&path)),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(Box::new(e))
        }
    }
}

fn mtime_millis(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn list_dir(d: &str) -> Result<Vec<Entry>, AnyErr> {
    let dir = PathBuf::from(d);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut entries = vec![];
    for item in fs::read_dir(&dir)? {
        let item = match item {
            Ok(v) => v,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
            continue;
        }
        let path = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        if !is_dir {
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !DOC_EXTS.contains(&ext.as_str()) {
                continue;
            }
        }
        entries.push(Entry {
            path: pstr(&path),
            dir: is_dir,
            name,
            mtime: mtime_millis(&meta),
            size: meta.len(),
            snippet: String::new(),
        });
        // 极端目录的安全上限；先收集、排序后再截断，
        // 保证「只显示前 300 项」是排序后的前 300 项而不是目录序的任意 300 项。
        if entries.len() >= MAX_LIST * 10 {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(MAX_LIST);
    // 摘要只读最终保留的文件，避免为被截断的条目白做 IO。
    for e in &mut entries {
        if !e.dir && e.size <= 256 * 1024 {
            if let Ok(bytes) = fs::read(&e.path) {
                let head: Vec<u8> = bytes.into_iter().take(700).collect();
                e.snippet = decode_text(&head).0;
            }
        }
    }
    Ok(entries)
}

/// Windows 下大小写不敏感，比较路径一律先小写化（沿用原实现的取舍）。
fn norm(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}

fn inside_fs_path(root: &str, target: &str) -> bool {
    let r = norm(root);
    let t = norm(target);
    let sep = std::path::MAIN_SEPARATOR;
    !r.is_empty() && (t == r || t.starts_with(&format!("{r}{sep}")))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(|c| c < '\u{20}')
}

fn trim_hit(mut s: String) -> String {
    if s.chars().count() > 120 {
        s = s.chars().take(120).collect();
    }
    s.trim().to_string()
}

pub fn search_files(dir: &str, query: &str, opts: SearchOpts) -> Result<SearchOutcome, AnyErr> {
    if query.is_empty() {
        return Ok(SearchOutcome { hits: vec![], truncated: false });
    }
    let matcher = build_matcher(query, &opts)?;
    let mut hits = vec![];
    let mut stack = vec![PathBuf::from(dir)];
    while let Some(cur) = stack.pop() {
        if hits.len() >= MAX_HITS_TOTAL {
            break;
        }
        let read = match fs::read_dir(&cur) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for item in read {
            let item = match item {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            let path = item.path();
            let meta = match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !DOC_EXTS.contains(&ext.as_str()) {
                continue;
            }
            if matcher.is_match(&name) {
                hits.push(Hit {
                    path: pstr(&path),
                    name: name.clone(),
                    line: 0,
                    col: 0,
                    text: String::new(),
                });
            }
            if meta.len() > SEARCHABLE_MAX || hits.len() >= MAX_HITS_TOTAL {
                continue;
            }
            let content = match fs::read(&path) {
                Ok(v) => decode_text(&v).0,
                Err(_) => continue,
            };
            let mut found = 0;
            for (ln, line) in content.lines().enumerate() {
                if let Some(m) = matcher.find(line) {
                    let col = line[..m.start()].chars().count();
                    hits.push(Hit {
                        path: pstr(&path),
                        name: name.clone(),
                        line: ln as u32 + 1,
                        col: col as u32 + 1,
                        text: trim_hit(line.to_string()),
                    });
                    found += 1;
                    if found >= MAX_HITS_PER_FILE || hits.len() >= MAX_HITS_TOTAL {
                        break;
                    }
                }
            }
        }
    }
    let truncated = hits.len() >= MAX_HITS_TOTAL;
    Ok(SearchOutcome { hits, truncated })
}

/// 跨文件批量替换：遍历目录下全部 Markdown/文本文档，保留原编码并原子落盘。
pub fn replace_in_files(
    dir: &str,
    query: &str,
    replacement: &str,
    opts: SearchOpts,
) -> Result<ReplaceOutcome, AnyErr> {
    if query.is_empty() {
        return Ok(ReplaceOutcome {
            files_changed: 0,
            replacements: 0,
            changed_paths: vec![],
        });
    }
    let matcher = build_matcher(query, &opts)?;
    let mut stack = vec![PathBuf::from(dir)];
    let mut files_changed = 0usize;
    let mut replacements = 0usize;
    let mut changed_paths = vec![];

    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else { continue };
        for ent in entries.flatten() {
            let path = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = ent.metadata() else { continue };
            if meta.is_dir() {
                if matches!(name.as_str(), "node_modules" | "target" | "dist") {
                    continue;
                }
                stack.push(path);
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !DOC_EXTS.contains(&ext.as_str()) || meta.len() > SEARCHABLE_MAX {
                continue;
            }
            let Ok(raw_bytes) = fs::read(&path) else { continue };
            let (content, encoding) = decode_text(&raw_bytes);
            let count = matcher.find_iter(&content).count();
            if count == 0 {
                continue;
            }
            let replaced = if opts.regex {
                matcher.replace_all(&content, replacement).into_owned()
            } else {
                matcher
                    .replace_all(&content, regex::NoExpand(replacement))
                    .into_owned()
            };
            if replaced == content {
                continue;
            }
            let out_bytes = encode_for_save(&replaced, &encoding)?;
            let target = pstr(&path);
            write_bytes_atomic(&target, &out_bytes)?;
            files_changed += 1;
            replacements += count;
            changed_paths.push(target);
        }
    }

    Ok(ReplaceOutcome {
        files_changed,
        replacements,
        changed_paths,
    })
}

pub fn create_entry(root: &str, dir: &str, name: &str, directory: bool) -> Result<String, AnyErr> {
    if !inside_fs_path(root, dir) || !safe_name(name) {
        return Err("非法路径或名称".into());
    }
    let path = PathBuf::from(dir).join(name);
    if path.exists() {
        return Err("同名文件或目录已存在".into());
    }
    if directory {
        fs::create_dir(&path)?;
    } else {
        fs::write(&path, "")?;
    }
    Ok(pstr(&path))
}

pub fn rename_entry(root: &str, source: &str, name: &str) -> Result<String, AnyErr> {
    if !inside_fs_path(root, source) || norm(root) == norm(source) || !safe_name(name) {
        return Err("非法路径或名称".into());
    }
    let src = PathBuf::from(source);
    let dest = src.with_file_name(name);
    if dest.exists() {
        return Err("同名文件或目录已存在".into());
    }
    fs::rename(&src, &dest)?;
    Ok(pstr(&dest))
}

pub fn trash_entry(root: &str, source: &str) -> Result<(), AnyErr> {
    if !inside_fs_path(root, source) || norm(root) == norm(source) {
        return Err("非法路径".into());
    }
    trash::delete(source).map_err(|e| format!("移入回收站失败：{e}").into())
}

pub fn move_entry(root: &str, source: &str, dest_dir: &str) -> Result<String, AnyErr> {
    if !inside_fs_path(root, source)
        || !inside_fs_path(root, dest_dir)
        || norm(root) == norm(source)
        || norm(source) == norm(dest_dir)
    {
        return Err("非法路径".into());
    }
    let src = PathBuf::from(source);
    let name = src.file_name().ok_or("非法路径")?;
    let dest = PathBuf::from(dest_dir).join(name);
    if dest.exists() {
        return Err("目标已存在".into());
    }
    // 不能把目录移到自己里面
    let with_sep = format!("{}{}", norm(source), std::path::MAIN_SEPARATOR);
    if norm(&pstr(&dest)).starts_with(&with_sep) {
        return Err("不能移动到自身内部".into());
    }
    fs::rename(&src, &dest)?;
    Ok(pstr(&dest))
}

pub fn show_entry(root: &str, source: &str) -> Result<(), AnyErr> {
    if !inside_fs_path(root, source) {
        return Err("非法路径".into());
    }
    std::process::Command::new("explorer")
        .args(["/select,", source])
        .spawn()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_matcher_modes() {
        let plain = SearchOpts::default();
        // 默认不区分大小写的子串匹配；正则元字符按字面处理
        let m = build_matcher("Foo", &plain).unwrap();
        assert!(m.is_match("foo bar"));
        let m = build_matcher("a.b", &plain).unwrap();
        assert!(m.is_match("a.b"));
        assert!(!m.is_match("axb"));
        // 区分大小写
        let cs = SearchOpts { match_case: true, ..Default::default() };
        let m = build_matcher("Foo", &cs).unwrap();
        assert!(m.is_match("Foo"));
        assert!(!m.is_match("foo"));
        // 全词
        let ww = SearchOpts { whole_word: true, ..Default::default() };
        let m = build_matcher("foo", &ww).unwrap();
        assert!(m.is_match("a foo b"));
        assert!(!m.is_match("afoo"));
        // 正则
        let re = SearchOpts { regex: true, ..Default::default() };
        let m = build_matcher(r"^#\s+\w+", &re).unwrap();
        assert!(m.is_match("# Title"));
        assert!(!m.is_match("text # Title"));
        assert!(build_matcher("([", &re).is_err());
    }

    #[test]
    fn utf8_passthrough() {
        let text = "# 标题\n\n正文 with ASCII\n";
        let (decoded, enc) = decode_text(text.as_bytes());
        assert_eq!(decoded, text);
        assert_eq!(enc, "utf-8");
        assert_eq!(encode_for_save(text, "utf-8").unwrap(), text.as_bytes());
    }

    #[test]
    fn gbk_roundtrip() {
        let text = "# 中文笔记\n\nGBK 编码的正文。\n";
        let (gbk, _, unmappable) = encoding_rs::GBK.encode(text);
        assert!(!unmappable);
        let (decoded, enc) = decode_text(&gbk);
        assert_eq!(enc, "gbk");
        assert_eq!(decoded, text);
        // 按检测出的编码写回，字节与原文一致
        assert_eq!(encode_for_save(&decoded, &enc).unwrap(), gbk.into_owned());
    }

    #[test]
    fn utf16le_roundtrip_with_bom() {
        let text = "# 标题\n正文\n";
        let mut bytes = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let (decoded, enc) = decode_text(&bytes);
        assert_eq!(decoded, text);
        assert!(enc.starts_with("utf-16"));
        let saved = encode_for_save(&decoded, &enc).unwrap();
        assert_eq!(&saved[..2], &[0xFF, 0xFE]);
        let (again, _) = decode_text(&saved);
        assert_eq!(again, text);
    }

    #[test]
    fn unmappable_char_errors_instead_of_replacing() {
        // emoji 在 GBK 里无法表示：必须报错提示另存 UTF-8，而不是静默变问号
        let err = encode_for_save("你好 🙂", "gbk").unwrap_err();
        assert!(err.to_string().contains("另存为"));
    }
}
