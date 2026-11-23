//! PicGo Server 图床上传。
//!
//! Plume 只做一件事：把已落盘的本地图片 POST 给用户本机运行的 PicGo Server，
//! 换回远程 URL。支持哪家图床（SM.MS / GitHub / 腾讯云 COS / 阿里云 OSS……）
//! 由用户在 PicGo 应用里配置，Plume 不经手任何图床凭据。
//!
//! 上传通道放在 Rust 侧而不是 webview fetch：绕开 CORS 限制（多数图床无 CORS 头），
//! 也让未来扩展直连适配器时有统一入口。

use crate::fs_ops::AnyErr;
use base64::Engine as _;
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

/// 与 images.rs 的落盘上限保持一致：传大图在 PicGo 那头也会被拒。
const MAX_UPLOAD: usize = 20 * 1024 * 1024;
const DEFAULT_PICGO_SERVER: &str = "http://127.0.0.1:36677";

fn picgo_base(server: Option<&str>) -> String {
    let clean = server.unwrap_or("").trim().trim_end_matches('/');
    if clean.is_empty() {
        DEFAULT_PICGO_SERVER.to_string()
    } else {
        clean.to_string()
    }
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    }
}

/// 探活：PicGo Server 的 GET /heartbeat，用于设置面板「测试连接」。
pub async fn ping(server: Option<&str>) -> bool {
    let url = format!("{}/heartbeat", picgo_base(server));
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(3)).build() else {
        return false;
    };
    matches!(client.get(&url).send().await, Ok(resp) if resp.status().is_success())
}

#[derive(Deserialize)]
struct PicgoResp {
    success: bool,
    result: Option<Vec<String>>,
}

/// 读本地图片 → data URL → POST {server}/upload（PicGo 约定的 JSON 格式），返回远程 URL。
pub async fn upload_picgo(abs_path: &str, server: Option<&str>) -> Result<String, AnyErr> {
    let src = Path::new(abs_path);
    if !src.is_file() {
        return Err("图片文件不存在".into());
    }
    let buf = std::fs::read(src)?;
    if buf.is_empty() || buf.len() > MAX_UPLOAD {
        return Err("图片为空或超过 20MiB 上限".into());
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let data = format!(
        "data:{};base64,{}",
        mime_of(&ext),
        base64::engine::general_purpose::STANDARD.encode(&buf)
    );

    let url = format!("{}/upload", picgo_base(server));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?;
    let resp: PicgoResp = client
        .post(&url)
        .json(&serde_json::json!({ "list": [data] }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if !resp.success {
        return Err("PicGo 返回上传失败，请查看 PicGo 日志".into());
    }
    let remote = resp
        .result
        .and_then(|list| list.into_iter().next())
        .unwrap_or_default();
    if remote.is_empty() {
        return Err("PicGo 未返回图片 URL".into());
    }
    Ok(remote)
}

/* ---------------- EasyImage 2.0 直连 ---------------- */

/// EasyImage 返回的 url 可能是完整链接，也可能只有路径（部分部署/反代场景），统一补全域名。
fn join_url(base: &str, path: &str) -> String {
    let p = path.trim();
    if p.starts_with("http://") || p.starts_with("https://") {
        return p.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), p.trim_start_matches('/'))
}

/// 探活：GET 站点首页，能通就算可达（EasyImage 没有专门的 heartbeat 接口）。
pub async fn ping_easyimage(base: &str) -> bool {
    let b = base.trim();
    if !b.starts_with("http://") && !b.starts_with("https://") {
        return false;
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() else {
        return false;
    };
    matches!(client.get(b).send().await, Ok(resp) if resp.status().is_success())
}

/// EasyImage 2.0 API：POST {base}/api/index.php，multipart 带 image 文件 + token。
/// 响应 {"result":"success","code":200,"url":...}；失败带 code/message（204 未选文件、205 被拦截、400 处理失败）。
/// 注意 EasyImage 服务端可能配置了格式转换/大小限制/鉴黄，报错信息原样透传给用户。
pub async fn upload_easyimage(abs_path: &str, base: &str, token: &str) -> Result<String, AnyErr> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 EasyImage 站点地址".into());
    }
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("EasyImage 站点地址需以 http:// 或 https:// 开头".into());
    }
    let token = token.trim();
    if token.is_empty() {
        return Err("未配置 EasyImage API Token（在图床后台「API设置」里生成）".into());
    }

    let src = Path::new(abs_path);
    if !src.is_file() {
        return Err("图片文件不存在".into());
    }
    let buf = std::fs::read(src)?;
    if buf.is_empty() || buf.len() > MAX_UPLOAD {
        return Err("图片为空或超过 20MiB 上限".into());
    }
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".to_string());
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let client = reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?;
    // 标准端点是 /api/index.php；个别老部署在 /api.php，404 时退而尝试
    let mut last_err: AnyErr = "EasyImage 请求失败".into();
    for endpoint in ["/api/index.php", "/api.php"] {
        let part = reqwest::multipart::Part::bytes(buf.clone())
            .file_name(name.clone())
            .mime_str(mime_of(&ext))?;
        let form = reqwest::multipart::Form::new()
            .text("token", token.to_string())
            .part("image", part);
        let attempt = client
            .post(format!("{base}{endpoint}"))
            .multipart(form)
            .send()
            .await;
        let resp = match attempt {
            Ok(r) => r,
            Err(e) => {
                last_err = Box::new(e);
                continue;
            }
        };
        // 404 才换备用端点；其它状态码继续解析 JSON 拿服务端的报错文案
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            last_err = "API 端点不存在（404），请检查站点地址".into();
            continue;
        }
        // 不走 error_for_status()：HTTP 非 2xx 时 EasyImage 也常带 JSON 说明，丢掉可惜
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let body: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => {
                // 非 JSON（PHP 报错页 / 反向代理 HTML）：带上响应片段，比“解析失败”有用得多
                let snippet: String = text.trim().chars().take(300).collect();
                return Err(format!(
                    "EasyImage 返回的不是 JSON（HTTP {status}）：{}",
                    if snippet.is_empty() { "响应为空".to_string() } else { snippet }
                )
                .into());
            }
        };
        let success = body
            .get("result")
            .and_then(|v| v.as_str())
            .map(|r| r == "success")
            .unwrap_or(false);
        if success {
            let remote = body
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            if remote.is_empty() {
                return Err("EasyImage 未返回图片 URL".into());
            }
            return Ok(join_url(base, remote));
        }
        let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        // EasyImage 的成功码固定 200；其余是它自己的业务码（见官方 docs/常见状态代码.md），
        // 201 这类在 check_api() 里直接返回、不带 message，这里补一句人能读懂的原因，
        // 前端弹窗再按 code 给排查建议。
        let reason = if message.is_empty() {
            match code {
                201 => "服务端已关闭 API 上传（后台 API 设置里未开启）",
                202 => "超出游客上传限制，或 Token 错误",
                203 => "Token 已过期",
                204 => "服务端没有收到图片文件",
                205 => "被服务端拦截（IP 黑白名单限制）",
                400 => "服务端处理失败（格式、尺寸或大小不符合后台设置）",
                401 => "服务端要求登录后才能上传",
                403 => "上传签名错误",
                406 => "服务端判定为非法文件",
                _ => "服务端未给出具体原因",
            }
            .to_string()
        } else {
            message
        };
        return Err(format!("EasyImage 上传失败：{reason}（code {code}，HTTP {status}）").into());
    }
    Err(last_err)
}
