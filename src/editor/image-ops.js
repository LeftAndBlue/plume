/**
 * 图片归集、粘贴落盘与图床上传（PicGo / EasyImage），从 runtime.js 抽离。
 */
import {
  EASYIMAGE_TOKEN_KEY,
  EASYIMAGE_URL_KEY,
  IMAGE_FOLDER_KEY,
  IMAGE_UPLOAD_MODE_KEY,
  IMAGE_UPLOAD_PROVIDER_KEY,
  PICGO_URL_KEY,
} from './storage-keys.js';
import { DEFAULT_IMAGE_FOLDER_TEMPLATE, resolveImageFolder } from './extrasText.js';
import { t } from '../i18n.js';

export function createImageOps({
  view,
  state,
  flash,
  copyText,
  insertAtCursor,
  imageSourceRange,
  openSheet,
  closeSettings,
  run,
  save,
}) {
/* ---------------- 图片 ---------------- */

function rawImageFolderTemplate() {
  try {
    return String(localStorage.getItem(IMAGE_FOLDER_KEY) || DEFAULT_IMAGE_FOLDER_TEMPLATE).trim() || DEFAULT_IMAGE_FOLDER_TEMPLATE;
  } catch {
    return DEFAULT_IMAGE_FOLDER_TEMPLATE;
  }
}

function currentImageFolder() {
  try {
    return resolveImageFolder(rawImageFolderTemplate(), state.path);
  } catch {
    return "assets";
  }
}

/* ---------------- 图床上传（PicGo Server） ---------------- */

const DEFAULT_PICGO_URL = "http://127.0.0.1:36677";

/** 插入图片时的上传策略：off=只落盘（默认）、upload=自动上传、ask=每次询问。 */
function imageUploadMode() {
  try {
    const v = localStorage.getItem(IMAGE_UPLOAD_MODE_KEY) || "off";
    // 旧版本曾用 picgo 表示自动上传，等价迁移到 upload
    return v === "picgo" ? "upload" : v;
  } catch {
    return "off";
  }
}

/** 图床服务：picgo（本机 PicGo Server，支持 SM.MS/GitHub/COS/OSS 等）/ easyimage（自部署 EasyImage 2.0 直连）。 */
function imageUploadProvider() {
  try {
    return localStorage.getItem(IMAGE_UPLOAD_PROVIDER_KEY) === "easyimage" ? "easyimage" : "picgo";
  } catch {
    return "picgo";
  }
}

function picgoUrl() {
  try {
    return String(localStorage.getItem(PICGO_URL_KEY) || "").trim() || DEFAULT_PICGO_URL;
  } catch {
    return DEFAULT_PICGO_URL;
  }
}

function easyimageUrl() {
  try {
    return String(localStorage.getItem(EASYIMAGE_URL_KEY) || "").trim();
  } catch {
    return "";
  }
}

function easyimageToken() {
  try {
    return String(localStorage.getItem(EASYIMAGE_TOKEN_KEY) || "").trim();
  } catch {
    return "";
  }
}

/** 按当前配置的图床服务上传一张已落盘的图片，返回远程 URL。配置缺失的报错来自 Rust 侧，文案可直接展示。 */
async function uploadViaProvider(abs) {
  if (imageUploadProvider() === "easyimage") {
    return window.studio.uploadImageEasyimage(abs, easyimageUrl(), easyimageToken());
  }
  return window.studio.uploadImage(abs, picgoUrl());
}

/**
 * 探活当前图床服务。返回 true/false；null 表示当前环境没有宿主能力（浏览器预览）。
 * 只在图床设置弹窗里用，测完把结果内联显示在按钮下方。
 */
async function probeImageHost() {
  const studio = window.studio;
  if (!studio) return null;
  try {
    if (imageUploadProvider() === "easyimage") {
      // 旧构建里没有这个命令时明确报「环境不支持」，而不是笼统的连接失败
      if (!studio.pingEasyimage) return null;
      return await studio.pingEasyimage(easyimageUrl());
    }
    if (!studio.pingImageUploader) return null;
    return await studio.pingImageUploader(picgoUrl());
  } catch {
    return false;
  }
}

/** 图床设置项的存储映射：键名 → [localStorage 键, 值归一化]。统一设置与独立弹窗共用。 */
const IMAGE_SETTING_SLOTS = {
  imageUploadMode: [IMAGE_UPLOAD_MODE_KEY, (v) => (["off", "upload", "ask"].includes(v) ? v : "off")],
  uploadProvider: [IMAGE_UPLOAD_PROVIDER_KEY, (v) => (["picgo", "easyimage"].includes(v) ? v : "picgo")],
  picgoUrl: [PICGO_URL_KEY, (v) => v.trim()],
  easyimageUrl: [EASYIMAGE_URL_KEY, (v) => v.trim()],
  easyimageToken: [EASYIMAGE_TOKEN_KEY, (v) => v.trim()],
};

function saveImageSetting(key, value) {
  const slot = IMAGE_SETTING_SLOTS[key];
  if (!slot) return;
  try {
    localStorage.setItem(slot[0], slot[1](String(value ?? "")));
  } catch {
    /* 存储不可用时按默认值运行，不打断设置流程 */
  }
}

/**
 * 上传失败弹窗：原始错误 + 按服务端状态码给出的排查建议 + 一键复制。
 * 只有状态栏一闪的话，code 201 这类信息根本看不出成因，所以失败一律走弹窗。
 */
function showUploadError(detail, { file, failures } = {}) {
  const text = [detail, file ? `${t("images.errorFile")}：${file}` : ""].filter(Boolean).join("\n");
  const esc = (s) =>
    String(s ?? "").replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
  const failed = failures?.length
    ? `<p class="settings-note">${failures.length} ${t("images.errorFailedCount")}：${esc(
        failures
          .slice(0, 6)
          .map((f) => f.src)
          .join("、"),
      )}${failures.length > 6 ? " …" : ""}</p>`
    : "";
  openSheet(
    t("images.errorTitle"),
    `<p class="settings-note">${t("images.errorLead")}</p>` +
      `<pre class="error-detail">${esc(text)}</pre>` +
      failed +
      `<p class="settings-group">${t("images.errHintTitle")}</p>` +
      `<p class="settings-note">${uploadErrorHint(detail)}</p>` +
      `<div class="settings-actions">` +
      `<button type="button" id="image-error-copy" class="settings-btn">${t("images.copyError")}</button>` +
      `<button type="button" id="image-error-close" class="settings-btn">${t("images.close")}</button>` +
      `</div>`,
  );
  document
    .getElementById("image-error-copy")
    ?.addEventListener("click", () => copyText(text, t("images.errorCopied")));
  document.getElementById("image-error-close")?.addEventListener("click", closeSettings);
}

/** 按 EasyImage 官方状态码给排查建议；PicGo / 网络错误走通用建议。 */
function uploadErrorHint(detail) {
  const code = /code\s*(\d+)/i.exec(String(detail || ""))?.[1];
  const known = ["201", "202", "203", "204", "205", "400", "401", "403", "406"];
  return t(`images.errHint.${known.includes(code) ? code : "other"}`);
}

function docDir() {
  return state.path ? String(state.path).replace(/[\\/][^\\/]*$/, "") : "";
}

/** 右键/批量场景：把正文里的引用解析成本地绝对路径，交 Rust 上传。 */
function localRefToAbs(src) {
  if (/^(?:data:|https?:|blob:|\/\/|file:)/i.test(src)) return null;
  const clean = src.split("?")[0].split("#")[0];
  if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith("\\\\")) return clean;
  const dir = docDir();
  if (!dir) return null;
  return dir + "\\" + clean.replace(/\//g, "\\").replace(/^\\+/, "");
}

/** 把正文里的若干候选引用（含 <尖括号> 形式）替换为远程 URL。 */
function replaceImageRefs(candidates, url) {
  const dest = imageDest(url);
  const text = view.state.doc.toString();
  let next = text;
  for (const ref of [...new Set(candidates)]) {
    if (!ref) continue;
    next = next
      .split(`<${ref}>`)
      .join(dest)
      .split(imageDest(ref))
      .join(dest)
      .split(ref)
      .join(dest);
  }
  if (next !== text) view.dispatch({ changes: { from: 0, to: text.length, insert: next } });
}

/**
 * 上传一张已落盘的图片（saved），成功后把正文里的本地引用（candidates）改写为远程 URL。
 * 本地文件保留在 assets/ 作为备份；失败只提示，不影响已插入的本地引用。
 */
async function uploadSavedImage(saved, candidates) {
  if (!window.studio?.uploadImage && !window.studio?.uploadImageEasyimage) return false;
  let url;
  try {
    url = await uploadViaProvider(saved.abs);
  } catch (err) {
    flash("图床上传失败（已保留本地引用）");
    showUploadError(err?.message || String(err), { file: saved.rel || saved.abs });
    return false;
  }
  // 未保存文档时贴的临时图：已换远程引用，保存时不再收进 assets/
  if (saved.abs) pastedAbs.delete(saved.abs);
  replaceImageRefs(candidates, url);
  flash("图片已上传图床：" + url);
  return true;
}

/**
 * 图床模式的「询问」改用应用内面板。
 * 原先走原生 blocking_show()：模态对话框会禁用整个主窗口，粘贴图片后
 * 用户只看到界面冻住（弹窗还可能在别的窗口后面），像是卡死。
 */
function askUploadImage() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    openSheet(
      "上传图片到图床",
      (body, close) => {
        const text = document.createElement("p");
        text.className = "settings-note";
        text.textContent = "刚插入的图片要上传到图床吗？上传成功后正文会换成远程地址，本地文件保留作备份。";
        const row = document.createElement("div");
        row.className = "ask-actions";
        const group = document.createElement("div");
        group.className = "ask-group";
        for (const [label, value, kind] of [
          ["上传", true, "primary"],
          ["暂不上传", false, "ghost"],
        ]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn-" + kind;
          b.textContent = label;
          b.addEventListener("click", () => {
            done(value);
            close();
          });
          group.appendChild(b);
        }
        row.append(group);
        body.append(text, row);
      },
      { onClose: () => done(false) },
    );
  });
}

/** attachImage 落盘并插入本地引用后，按设置决定是否跟一次图床上传。 */
function maybeUploadAfterAttach(saved, inserted) {
  const mode = imageUploadMode();
  if (mode !== "upload" && mode !== "ask") return;
  const run = async () => {
    if (mode === "ask") {
      if (!(await askUploadImage())) return;
    }
    // 同时尝试 abs / rel 两种写法：用户可能在保存文档时 rel 已替换过正文里的临时绝对路径
    await uploadSavedImage(saved, [inserted, saved.rel]);
  };
  run().catch(() => {});
}

/** 右键菜单：上传指定图片到图床。基于源码位置精确替换，避免全文重写的竞态。 */
async function uploadImageFromMenu(el) {
  const info = imageSourceRange(el);
  if (!info || !state.path || !window.studio?.uploadImageEasyimage) return flash("请先保存文档，再上传本地图片");
  const abs = localRefToAbs(info.src);
  if (!abs) return flash("远程或内嵌图片无需上传");
  let url;
  try {
    url = await uploadViaProvider(abs);
  } catch (err) {
    return showUploadError(err?.message || String(err), { file: info.src });
  }
  const at = info.raw.indexOf(info.src);
  if (at < 0) return flash("图片源码位置已变化，请重试");
  const raw = info.raw.slice(0, at) + imageDest(url) + info.raw.slice(at + info.src.length);
  view.dispatch({ changes: { from: info.from, to: info.to, insert: raw } });
  flash("图片已上传图床：" + url);
}

/** 命令：把本文所有本地图片批量上传到图床，成功一张改写一张。 */
async function uploadDocumentImages() {
  if (!state.path || !window.studio?.uploadImageEasyimage) return flash("请先保存文档并配置图床，再批量上传");
  const re = /(!\[[^\]\n]*\]\()([^)\n]+)(\))/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(view.state.doc.toString()))) {
    const body = m[2].trim();
    const src = /^<([^>]+)>/.exec(body)?.[1] || body.split(/\s+["']/)[0].trim();
    const abs = src && localRefToAbs(src);
    if (abs) seen.add(JSON.stringify([src, abs]));
  }
  const items = [...seen].map((s) => JSON.parse(s));
  if (!items.length) return flash("本文没有可上传的本地图片");
  let ok = 0;
  const failures = [];
  for (const [src, abs] of items) {
    let url;
    try {
      url = await uploadViaProvider(abs);
    } catch (err) {
      failures.push({ src, msg: err?.message || String(err) });
      continue;
    }
    // 正文里的引用是相对路径 src；abs 一并列入以覆盖未保存文档的绝对引用写法
    replaceImageRefs([src, abs], url);
    ok++;
  }
  flash(ok ? `已上传 ${ok} 张图片到图床${failures.length ? `，${failures.length} 张失败` : ""}` : "全部图片上传失败");
  if (failures.length) showUploadError(failures[0].msg, { failures });
}

/** 文档还没保存时粘贴的图片，记的是临时目录里的绝对路径。保存时再收进 assets/。 */
const pastedAbs = new Set();

function imageDest(rel) {
  return /[\s()]/.test(rel) ? `<${rel}>` : rel;
}

/**
 * 图片落盘 + 插入。三个入口（选择文件 / 粘贴 / 拖入）共用。
 *
 * 文档已经有路径：写到旁边的 assets/，插入相对路径。
 * 还没保存：先写到临时目录并插入绝对路径，马上就能显示，不必先另存。
 * 之后真正保存时，settlePastedImages 会把这些图拷进文档目录并改成相对路径。
 */
async function attachImage(buf, ext) {
  if (!window.studio) return false;
  const saved = await window.studio.saveImage(buf, ext, state.path || null, currentImageFolder());
  if (!saved) return false;
  // saveImage 返回 { abs, rel, doc_dir }：已保存文档插入相对路径，未保存插入绝对路径（先能显示）。
  const dest = state.path ? saved.rel : saved.abs;
  if (!dest) return false;
  if (!state.path) pastedAbs.add(saved.abs);
  insertAtCursor(`![](${imageDest(dest)})`);
  flash(state.path ? "图片已保存到 " + saved.rel : "图片已插入");
  // 图床模式：先落盘保证立即可见，上传成功后再把引用改写为远程 URL（本地文件保留作备份）
  maybeUploadAfterAttach(saved, dest);
  return true;
}

/** 把未保存时粘贴的临时图片收进文档旁边的 assets/，并改写正文里的路径。 */
async function settlePastedImages(content, docPath) {
  if (!pastedAbs.size || !window.studio || !docPath) return content;
  let next = content;
  for (const abs of [...pastedAbs]) {
    if (!next.includes(abs)) {
      pastedAbs.delete(abs);
      continue;
    }
    const saved = await window.studio.adoptImage(abs, docPath, currentImageFolder());
    if (!saved) continue;
    const dest = imageDest(saved.rel || saved);
    next = next.split(`<${abs}>`).join(dest);
    next = next.split(abs).join(dest);
  }
  return next;
}

function forgetMissingPastes(text) {
  for (const abs of [...pastedAbs]) {
    if (!text.includes(abs)) pastedAbs.delete(abs);
  }
}

async function collectDocumentImages() {
  if (!state.path || !window.studio?.collectImages) {
    flash("请先保存文档，再整理图片");
    return;
  }
  const text = view.state.doc.toString();
  const sources = new Set();
  const re = /(!\[[^\]\n]*\]\()([^)\n]+)(\))/g;
  let m;
  while ((m = re.exec(text))) {
    const body = m[2].trim();
    const src = /^<([^>]+)>/.exec(body)?.[1] || body.split(/\s+["']/)[0].trim();
    if (src && !/^(?:data:|https?:|file:|blob:|\/\/)/i.test(src)) sources.add(src);
  }
  if (!sources.size) {
    flash("本文没有需要整理的本地图片");
    return;
  }
  const moved = await window.studio.collectImages([...sources], state.path, currentImageFolder());
  let changed = 0;
  const next = text.replace(re, (whole, head, raw, tail) => {
    const body = raw.trim();
    const src = /^<([^>]+)>/.exec(body)?.[1] || body.split(/\s+["']/)[0].trim();
    // collectImages 返回 { 源路径: { abs, rel, doc_dir } }，替换时用相对路径字段。
    const target = moved[src] && (moved[src].rel || moved[src]);
    if (!target || target === src) return whole;
    changed++;
    return head + raw.replace(src, target) + tail;
  });
  if (changed) {
    view.dispatch({ changes: { from: 0, to: text.length, insert: next } });
    await save();
  }
  flash(changed ? `已整理 ${changed} 处图片引用到 ${currentImageFolder()}/` : "图片已经在当前目录中");
}

function pickImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop() || "png";
    if (window.studio) await attachImage(await file.arrayBuffer(), ext);
    else insertAtCursor(`![](${URL.createObjectURL(file)})`);
  });
  input.click();
}


  return {
    DEFAULT_PICGO_URL,
    rawImageFolderTemplate,
    currentImageFolder,
    imageUploadMode,
    imageUploadProvider,
    picgoUrl,
    easyimageUrl,
    easyimageToken,
    probeImageHost,
    saveImageSetting,
    uploadImageFromMenu,
    uploadDocumentImages,
    attachImage,
    settlePastedImages,
    forgetMissingPastes,
    collectDocumentImages,
    pickImage,
  };
}
