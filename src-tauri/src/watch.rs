//! 目录监听：notify 监听文档所在目录（非递归）。
//! - 当前文档被外部修改 → `doc-external-change`（300ms 去抖，比对 mtime + 内容指纹）
//! - 目录内容变化 → `fs-changed`（500ms 去抖，文件树据此刷新）
//! 自己保存时 `note_self_write` 会登记写入后的 mtime 与内容指纹，
//! 自写产生的事件在监听线程里被过滤掉，不会误报「文件已在其他程序中修改」。

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched_doc: Arc<Mutex<Option<PathBuf>>>,
    last_mtime: Arc<Mutex<u64>>,
    /// 我们最后一次见到/写入的文档内容指纹；与磁盘一致的事件视为自写，不上报。
    last_hash: Arc<Mutex<Option<u64>>>,
}

impl Default for WatchState {
    fn default() -> Self {
        Self {
            watcher: Mutex::new(None),
            watched_doc: Arc::new(Mutex::new(None)),
            last_mtime: Arc::new(Mutex::new(0)),
            last_hash: Arc::new(Mutex::new(None)),
        }
    }
}

/// 纳秒精度：秒级粒度会把同一秒内的外部修改误判成自写。
fn mtime_nanos(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn content_hash(p: &Path) -> Option<u64> {
    std::fs::read(p).ok().map(|bytes| hash_bytes(&bytes))
}

/// 保存成功后由 file_save / file_save_as 调用：登记自写的 mtime 与内容指纹。
/// 指纹直接读磁盘字节（而非前端传入的 UTF-8 文本），GBK/UTF-16 等按原编码写回时同样一致。
/// 必须赶在监听线程 300ms 去抖到期之前完成（命令返回前同步执行，余量充足）。
pub fn note_self_write(app: &AppHandle, p: &str) {
    let state = app.state::<WatchState>();
    let path = Path::new(p);
    let Ok(watched) = state.watched_doc.lock() else { return };
    if watched.as_deref() != Some(path) {
        return;
    }
    let hash = content_hash(path);
    let Ok(mut m) = state.last_mtime.lock() else { return };
    *m = mtime_nanos(path);
    let Ok(mut h) = state.last_hash.lock() else { return };
    *h = hash;
}

pub fn watch_document(app: &AppHandle, p: Option<String>) -> Result<(), String> {
    let state = app.state::<WatchState>();
    *state.watcher.lock().map_err(|e| e.to_string())? = None;
    *state.watched_doc.lock().map_err(|e| e.to_string())? = None;
    let Some(p) = p else { return Ok(()) };
    let path = PathBuf::from(&p);
    let dir = path.parent().map(Path::to_path_buf).ok_or("没有父目录")?;
    *state.last_mtime.lock().map_err(|e| e.to_string())? = mtime_nanos(&path);
    *state.last_hash.lock().map_err(|e| e.to_string())? = content_hash(&path);
    *state.watched_doc.lock().map_err(|e| e.to_string())? = Some(path.clone());

    let (tx, rx) = channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    let doc = path.clone();
    let watched_doc = Arc::clone(&state.watched_doc);
    let last_mtime = Arc::clone(&state.last_mtime);
    let last_hash = Arc::clone(&state.last_hash);
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut doc_dirty_at: Option<Instant> = None;
        let mut fs_dirty_at: Option<Instant> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(120)) {
                Ok(Ok(event)) => {
                    let interesting = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    );
                    if !interesting {
                        continue;
                    }
                    let hit_doc = event.paths.iter().any(|changed| *changed == doc);
                    if hit_doc {
                        doc_dirty_at = Some(Instant::now());
                    } else {
                        fs_dirty_at = Some(Instant::now());
                    }
                }
                Ok(Err(_)) => continue,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if let Some(at) = doc_dirty_at {
                if at.elapsed() >= Duration::from_millis(300) {
                    doc_dirty_at = None;
                    let still_watching = watched_doc
                        .lock()
                        .map(|guard| guard.as_deref() == Some(doc.as_path()))
                        .unwrap_or(false);
                    if !still_watching {
                        break;
                    }
                    let m = mtime_nanos(&doc);
                    let changed = last_mtime
                        .lock()
                        .map(|mut guard| {
                            if *guard != m {
                                *guard = m;
                                true
                            } else {
                                false
                            }
                        })
                        .unwrap_or(false);
                    if changed {
                        // mtime 变了还要比内容指纹：自己保存（note_self_write 已登记）
                        // 或内容等价的写入不上报，只有真正的外部修改才发事件。
                        // 文件被删除时 content_hash 为 None，同样上报交给前端处理。
                        let h = content_hash(&doc);
                        let external = last_hash
                            .lock()
                            .map(|mut guard| {
                                if *guard != h {
                                    *guard = h;
                                    true
                                } else {
                                    false
                                }
                            })
                            .unwrap_or(false);
                        if external {
                            let _ = app_handle.emit("doc-external-change", doc.to_string_lossy());
                        }
                    }
                }
            }
            if let Some(at) = fs_dirty_at {
                if at.elapsed() >= Duration::from_millis(500) {
                    fs_dirty_at = None;
                    let _ = app_handle.emit("fs-changed", dir.to_string_lossy());
                }
            }
            // 切走文档后旧监听线程自行退出
            let still_watching = watched_doc
                .lock()
                .map(|guard| guard.is_some())
                .unwrap_or(false);
            if !still_watching {
                break;
            }
        }
    });
    Ok(())
}
