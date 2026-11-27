/**
 * 设置面板、主题商店、图床设置、拼写词典与许可弹窗，从 runtime.js 抽离。
 */
import { IMAGE_FOLDER_KEY, RECENT_KEY } from './storage-keys.js';
import {
  THEMES,
  applyAppearanceCommand,
  applyTheme,
  currentThemeId,
  getAppearance,
  updateAppearance,
} from './theme.js';
import { LOCALES, i18n, setLocale, t } from '../i18n.js';

export function createSettingsModal({ state, flash, getImageOps, exportSettings, importSettings }) {
  const DEFAULT_PICGO_URL = 'http://127.0.0.1:36677';
  const currentImageFolder = () => getImageOps().currentImageFolder();
  const rawImageFolderTemplate = () => getImageOps().rawImageFolderTemplate?.() || currentImageFolder();
  const imageUploadMode = () => getImageOps().imageUploadMode();
  const imageUploadProvider = () => getImageOps().imageUploadProvider();
  const picgoUrl = () => getImageOps().picgoUrl();
  const easyimageUrl = () => getImageOps().easyimageUrl();
  const easyimageToken = () => getImageOps().easyimageToken();
  const probeImageHost = () => getImageOps().probeImageHost();
  const saveImageSetting = (k, v) => getImageOps().saveImageSetting(k, v);
  const collectDocumentImages = () => getImageOps().collectDocumentImages();
  const uploadDocumentImages = () => getImageOps().uploadDocumentImages();

const LICENSE_TEXT = [
  "Plume 以 MIT 许可证开源，仓库根目录 LICENSE 文件为准。",
  "",
  `MIT License

Copyright (c) 2026 LeftAndBlue

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  "",
  "界面里用到的第三方组件各自保留原许可证：",
  "Tauri、CodeMirror、Lezer、KaTeX、Mermaid、Vue、Lucide。",
].join("\n");

/** 打开设置面板：content 可以是 HTML 字符串，也可以是 (body, close) 回调（用于需要绑事件的询问面板）。 */
let sheetOnClose = null;
function openSheet(title, content, options) {
  const panel = document.getElementById("settings");
  const body = document.getElementById("settings-body");
  const heading = document.getElementById("settings-title");
  if (!panel || !body) return;
  if (heading) heading.textContent = title;
  panel.querySelector('.settings-card')?.classList.toggle("is-wide", !!options?.wide);
  sheetOnClose = typeof options?.onClose === "function" ? options.onClose : null;
  body.replaceChildren();
  if (typeof content === "function") content(body, closeSettings);
  else body.innerHTML = content ?? "";
  panel.hidden = false;
}

function showLicense() {
  openSheet(t("menu.license"), `<pre class="license-copy">${LICENSE_TEXT.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]))}</pre>`);
}

function openThemeStore() {
  const current = currentThemeId();
  const cards = THEMES.map((t) => {
    const [paper, accent, ink] = t.swatch;
    return `<button type="button" class="theme-card${t.id === current ? " is-on" : ""}" data-theme="${t.id}">
      <span class="theme-swatch" style="background:${paper};color:${ink}"><i style="background:${accent}"></i>Aa</span>
      <span>${t.label}</span>
    </button>`;
  }).join("");
  openSheet(
    t("themeStore.title"),
    `<div class="theme-grid">${cards}</div>
     <button type="button" id="back-settings" class="settings-btn">${t("themeStore.back")}</button>
     <button type="button" id="theme-folder" class="settings-btn">${t("themeStore.openFolder")}</button>
     <p class="settings-note">${t("themeStore.note")}</p>`,
  );
  document.getElementById("settings-body")?.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.theme);
      document.querySelectorAll(".theme-card").forEach((card) => {
        card.classList.toggle("is-on", card.dataset.theme === btn.dataset.theme);
      });
    });
  });
  document.getElementById("theme-folder")?.addEventListener("click", () => window.studio?.openThemeFolder());
  document.getElementById("back-settings")?.addEventListener("click", () => openSettings());
}

function rangeField(label, key, value, min, max, step, suffix) {
  return `<label class="settings-row"><span>${label}</span><input data-k="${key}" data-suffix="${suffix || ""}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><b data-for="${key}">${value}${suffix || ""}</b></label>`;
}

async function openSettings() {
  const prefs = getAppearance();
  const opt = (value, text, current) =>
    `<option value="${value}"${String(value) === String(current) ? " selected" : ""}>${text}</option>`;
  const field = (label, html) => `<label class="settings-row"><span>${label}</span>${html}</label>`;
  openSheet(
    t("settings.title"),
    `<p class="settings-group">${t("settings.general")}</p>` +
      field(
        t("settings.language"),
        `<select id="locale-select">${LOCALES.map((l) => opt(l.id, l.label, i18n.locale)).join("")}</select>`,
      ) +
      `<p class="settings-group">${t("settings.appearance")}</p>` +
      field(t("settings.theme"), `<select data-k="theme">${THEMES.map((th) => opt(th.id, th.label, prefs.theme)).join("")}</select>`) +
      field(
        t("settings.density"),
        `<select data-k="density">${opt("compact", t("settings.density.compact"), prefs.density)}${opt("comfortable", t("settings.density.comfortable"), prefs.density)}${opt("loose", t("settings.density.loose"), prefs.density)}</select>`,
      ) +
      rangeField(t("settings.fontSize"), "fontSize", prefs.fontSize, 12, 28, 1, "") +
      rangeField(t("settings.lineHeight"), "lineHeight", prefs.lineHeight, 1.4, 2.2, 0.05, "") +
      rangeField(t("settings.paraEm"), "paraEm", prefs.paraEm, 0, 2, 0.05, "em") +
      rangeField(t("settings.blockPx"), "blockPx", prefs.blockPx, 0, 32, 1, "px") +
      rangeField(t("settings.contentPx"), "contentPx", prefs.pageWidth === "full" ? 800 : prefs.contentPx, 640, 1200, 20, "px") +
      field(t("settings.pageFull"), `<input data-k="pageFull" type="checkbox"${prefs.pageWidth === "full" ? " checked" : ""}>`) +
      field(
        t("settings.fontStyle"),
        `<select data-k="fontStyle">${opt("theme", t("settings.fontStyle.theme"), prefs.fontStyle)}${opt("sans", t("settings.fontStyle.sans"), prefs.fontStyle)}${opt("serif", t("settings.fontStyle.serif"), prefs.fontStyle)}${opt("custom", t("settings.fontStyle.custom"), prefs.fontStyle)}</select>`,
      ) +
      field(t("settings.fontFamily"), `<input data-k="fontFamily" type="text" value="${String(prefs.fontFamily || "").replace(/"/g, "&quot;")}" placeholder="${t("settings.fontFamilyPh")}">`) +
      rangeField(t("settings.codePx"), "codePx", prefs.codePx || 0, 0, 22, 1, "") +
      field(t("settings.firstLineIndent"), `<input data-k="firstLineIndent" type="checkbox"${prefs.firstLineIndent ? " checked" : ""}>`) +
      field(t("settings.codeLineNumbers"), `<input data-k="codeLineNumbers" type="checkbox"${prefs.codeLineNumbers ? " checked" : ""}>`) +
      `<p class="settings-note">${t("settings.appearanceNote")}</p>` +
      `<button type="button" id="open-theme-store" class="settings-btn">${t("settings.openThemeStore")}</button>` +
      `<p class="settings-group">${t("settings.exportGroup")}</p>` +
      field(
        t("settings.exportTemplate"),
        `<select data-k="exportTemplate">${opt("doc", t("settings.exportTemplate.doc"), prefs.exportTemplate)}${opt("book", t("settings.exportTemplate.book"), prefs.exportTemplate)}${opt("paper", t("settings.exportTemplate.paper"), prefs.exportTemplate)}</select>`,
      ) +
      `<p class="settings-note">${t("settings.exportTemplateNote")}</p>` +
      `<p class="settings-group">${t("settings.spelling")}</p>` +
      field(t("settings.spellcheck"), `<input data-k="spellcheck" type="checkbox"${prefs.spellcheck ? " checked" : ""}>`) +
      `<div id="spell-list"><p class="settings-note">${t("settings.spellLoading")}</p></div>` +
      `<p class="settings-note">${t("settings.spellNote")}</p>` +
      `<p class="settings-group">${t("settings.images")}</p>` +
      field(t("settings.imageFolder"), `<input data-k="imageFolder" type="text" value="${rawImageFolderTemplate().replace(/"/g, "&quot;")}" placeholder="${t("settings.imageFolderPh")}">`) +
      `<p class="settings-note">${t("settings.imageNote")} <span id="settings-image-folder-preview" class="settings-preview">→ ${currentImageFolder().replace(/</g, "&lt;")}/</span></p>` +
      `<button type="button" id="settings-collect-images" class="settings-btn">${t("settings.collectImages")}</button>` +
      `<div class="settings-actions"><button type="button" id="settings-image-host" class="settings-btn">${t("settings.openImageHost")}</button></div>` +
      `<p></p>` +
      `<button type="button" id="settings-clear-recent" class="settings-btn">${t("settings.clearRecent")}</button>` +
      `<p class="settings-group">${t("settings.backup")}</p>` +
      `<p class="settings-note">${t("settings.backupNote")}</p>` +
      `<div class="settings-actions"><button type="button" id="settings-export" class="settings-btn">${t("settings.export")}</button><button type="button" id="settings-import" class="settings-btn">${t("settings.import")}</button></div>`,
  );
  const body = document.getElementById("settings-body");
  const write = (el) => {
    const key = el.dataset.k;
    if (key === "imageFolder") {
      try {
        localStorage.setItem(IMAGE_FOLDER_KEY, el.value.trim() || "${filename}.assets");
      } catch {
        /* 记住目录是增强项，存储不可用时不影响插图 */
      }
      const pv = document.getElementById("settings-image-folder-preview");
      if (pv) pv.textContent = "→ " + currentImageFolder() + "/";
      return;
    }
    if (el.type === "checkbox" && key === "pageFull") {
      updateAppearance({ pageWidth: el.checked ? "full" : "custom" });
      return;
    }
    if (el.type === "checkbox") {
      updateAppearance({ [key]: el.checked });
      return;
    }
    if (key === "fontSize" || key === "blockPx" || key === "codePx" || key === "contentPx") {
      const n = Number(el.value);
      const patch = { [key]: n };
      if (key === "contentPx") patch.pageWidth = "custom";
      updateAppearance(patch);
    } else if (key === "lineHeight" || key === "paraEm") {
      updateAppearance({ [key]: Number(el.value) });
    } else if (key === "density") {
      applyAppearanceCommand("density:" + el.value);
    } else if (key === "fontFamily") {
      updateAppearance({ fontFamily: el.value, fontStyle: el.value ? "custom" : getAppearance().fontStyle });
    } else updateAppearance({ [key]: el.type === "number" ? Number(el.value) : el.value });
    const out = body.querySelector(`[data-for="${key}"]`);
    if (out) out.textContent = el.value + (el.dataset.suffix || "");
  };
  body.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("input", () => write(el));
    el.addEventListener("change", () => write(el));
  });
  document.getElementById("settings-clear-recent")?.addEventListener("click", () => {
    localStorage.removeItem(RECENT_KEY);
    flash("最近打开已清空");
  });
  document.getElementById("settings-export")?.addEventListener("click", () => {
    exportSettings().catch((err) => flash("导出设置失败：" + (err && err.message ? err.message : err)));
  });
  document.getElementById("settings-import")?.addEventListener("click", () => {
    importSettings().catch((err) => flash("导入设置失败：" + (err && err.message ? err.message : err)));
  });
  document.getElementById("open-theme-store")?.addEventListener("click", openThemeStore);
  // 切换语言：持久化 + 通知菜单栏，再按新语言重画面板
  document.getElementById("locale-select")?.addEventListener("change", (e) => {
    setLocale(e.target.value);
    openSettings();
  });
  document.getElementById("settings-collect-images")?.addEventListener("click", () => {
    collectDocumentImages().catch((err) => flash("整理图片失败：" + (err?.message || err)));
  });
  document.getElementById("settings-image-host")?.addEventListener("click", () => openImageSettings());
  fillSpellList();
}

/**
 * 独立「图床设置」弹窗：只放图床相关内容（插入方式、服务选择、凭据、测试、批量上传）。
 * 统一设置面板里只留本地图片目录，点「图床设置…」跳到这里。
 */
function openImageSettings() {
  const q = (v) => String(v ?? "").replace(/"/g, "&quot;");
  const opt = (value, text, current) =>
    `<option value="${value}"${String(value) === String(current) ? " selected" : ""}>${text}</option>`;
  const row = (label, html) => `<label class="settings-row"><span>${label}</span>${html}</label>`;
  const provider = imageUploadProvider();

  openSheet(
    t("images.settingsTitle"),
    `<p class="settings-group">${t("images.insertGroup")}</p>` +
      row(
        t("settings.imageUploadMode"),
        `<select data-img="imageUploadMode">${opt("off", t("settings.imageUpload.off"), imageUploadMode())}${opt("upload", t("settings.imageUpload.upload"), imageUploadMode())}${opt("ask", t("settings.imageUpload.ask"), imageUploadMode())}</select>`,
      ) +
      `<p class="settings-note">${t("images.modeNote")}</p>` +
      `<p class="settings-group">${t("images.providerGroup")}</p>` +
      row(
        t("settings.uploadProvider"),
        `<select data-img="uploadProvider">${opt("picgo", "PicGo（本机应用）", provider)}${opt("easyimage", "EasyImage（自部署）", provider)}</select>`,
      ) +
      `<div data-provider="picgo">` +
      row(t("settings.picgoUrl"), `<input data-img="picgoUrl" type="text" value="${q(picgoUrl())}" placeholder="${DEFAULT_PICGO_URL}">`) +
      `<p class="settings-note">${t("images.picgoNote")}</p>` +
      `</div>` +
      `<div data-provider="easyimage">` +
      row(t("settings.easyimageUrl"), `<input data-img="easyimageUrl" type="text" value="${q(easyimageUrl())}" placeholder="https://img.example.com">`) +
      row(t("settings.easyimageToken"), `<input data-img="easyimageToken" type="password" value="${q(easyimageToken())}" placeholder="${t("settings.easyimageTokenPh")}">`) +
      `<p class="settings-note">${t("images.easyimageNote")}</p>` +
      `</div>` +
      `<div class="settings-actions">` +
      `<button type="button" id="image-host-test" class="settings-btn">${t("settings.picgoTest")}</button>` +
      `<button type="button" id="image-host-upload" class="settings-btn">${t("menu.uploadImages")}</button>` +
      `</div>` +
      `<p class="settings-note" id="image-host-state"></p>` +
      `<p class="settings-note">${t("images.localNote")}</p>`,
  );

  const panel = document.getElementById("settings-body");
  if (!panel) return;

  /** 只显示当前选中服务的配置块；切换服务时清掉旧的测试结果，避免误导。 */
  const paintProvider = () => {
    const active = imageUploadProvider();
    panel.querySelectorAll("[data-provider]").forEach((el) => {
      el.hidden = el.dataset.provider !== active;
    });
    const state = document.getElementById("image-host-state");
    if (state) {
      state.textContent = "";
      state.className = "settings-note";
    }
  };
  paintProvider();

  panel.querySelectorAll("[data-img]").forEach((el) => {
    const save = () => {
      saveImageSetting(el.dataset.img, el.value);
      if (el.dataset.img === "uploadProvider") paintProvider();
    };
    // 输入框边打边存；下拉框在 change 时存
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", save);
  });

  document.getElementById("image-host-test")?.addEventListener("click", async () => {
    const btn = document.getElementById("image-host-test");
    const state = document.getElementById("image-host-state");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = t("images.testing");
    state.textContent = "";
    state.className = "settings-note";
    try {
      const ok = await probeImageHost();
      state.textContent = ok === null ? t("images.unsupported") : ok ? t("settings.picgoOk") : t("settings.picgoFail");
      if (ok !== null) state.classList.add(ok ? "is-ok" : "is-bad");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  document.getElementById("image-host-upload")?.addEventListener("click", () => {
    closeSettings();
    uploadDocumentImages().catch((err) => flash("上传图片失败：" + (err?.message || err)));
  });
}

async function fillSpellList() {
  const host = document.getElementById("spell-list");
  if (!host) return;
  if (!window.studio?.listSpell) {
    host.innerHTML = `<p class="settings-note">词典下载需要桌面版。浏览器里只能使用系统自带的拼写检查。</p>`;
    return;
  }
  let status;
  try {
    status = await window.studio.listSpell();
  } catch (err) {
    host.textContent = "";
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = "读词典失败：" + (err && err.message ? err.message : err);
    host.appendChild(note);
    return;
  }
  host.innerHTML = (status.dictionaries || [])
    .map((item) => {
      const ready = item.installed
        ? `<span class="spell-ready">${item.systemOnly ? "系统已安装" : "已下载"}</span>`
        : item.systemOnly
          ? `<span>系统未安装</span>`
          : `<button type="button" class="settings-btn" data-dict="${item.id}">下载</button>`;
      return `<div class="spell-row"><span>${item.label}</span>${ready}</div>`;
    })
    .join("");
  host.querySelectorAll("[data-dict]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lang = btn.dataset.dict;
      btn.disabled = true;
      btn.innerHTML = '<span class="motion-loading" aria-hidden="true"><i></i><i></i><i></i></span>';
      try {
        await window.studio.downloadSpell(lang);
        await fillSpellList();
        flash("词典已下载");
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "重试";
        flash("下载失败：" + (err && err.message ? err.message : err));
      }
    });
  });
}

function closeSettings() {
  const panel = document.getElementById("settings");
  const hook = sheetOnClose;
  sheetOnClose = null;
  if (panel) panel.hidden = true;
  if (hook) hook();
}

  return {
    openSheet,
    closeSettings,
    showLicense,
    openThemeStore,
    openSettings,
    openImageSettings,
  };
}
