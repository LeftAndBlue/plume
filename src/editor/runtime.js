import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createEditorFormatting, olPrefix, quotePrefix, taskPrefix, ulPrefix } from "./editor-formatting.js";
import {
  foldAllHeadings,
  foldCurrentHeading,
  unfoldAllHeadings,
  unfoldCurrentHeading,
} from "./heading-fold.js";
import { buildPaletteCommands, createMenus } from "./menu-config.js";
import { createEditorSetup } from "./editor-setup.js";
import { createEditorContext } from "./editor-context.js";
import { createDraftUI } from "./draft-ui.js";
import { createOutlineSync } from "./outline-sync.js";
import { createFsOpsUI, samePath } from "./fs-ops-ui.js";
import { createSplitPane } from "./split-pane.js";
import { createContextMenu } from "./context-menu.js";
import { createImageOps } from "./image-ops.js";
import { createSettingsModal } from "./settings-modal.js";
import { computeWordGoalProgress, countParagraphs, panguSpacing } from "./extrasText.js";
import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { refreshDecorations, setSourceMode, sourceModeField } from "./live-preview.js";
import { getCodeFences, isFenceDraft } from "./code-fences.js";
import { buildOutline } from "./outline.js";
import { cancelCellEditor } from "./table-edit.js";
import { onTexReady } from "./inline-text.js";
import { detectCode, pasteAsCodeBlock } from "./paste-code.js";
import { renderSelectionForClipboard, resolveImageForClipboard } from "./clipboard.js";
import { renderWeChatHtml } from "./wechat-html.js";
import { createJumpHistory, FONT_SIZE_DEFAULT, stepFontSize } from "./jump-history.js";
import { createTabsManager } from "./tabs.js";
import { createFileIO } from "./file-io.js";
import { createMenubar } from "./menubar.js";
import { ACCEL, shortcutGroups, shortcutNotes } from "./shortcuts.js";
import { slugify } from "./slugify.js";
import { createQuickOpen } from "./quick-open.js";
import { createSettingsBackup } from "./settings-backup.js";
import { createUpdater } from "../platform/updater.js";
import { t } from "../i18n.js";
import { WORD_GOAL_KEY, SIDE_OPEN_KEY, SIDEBAR_WIDTH_KEY } from "./storage-keys.js";
import {
  THEMES,
  applyAppearanceCommand,
  applyTheme,
  bindThemeEditorView,
  currentThemeId,
  getAppearance,
  initTheme,
  updateAppearance,
} from "./theme.js";
import { blinkLine, setDocBase, setLocalUrlConverter } from "./widgets.js";
import { useShellStore } from "../stores/shell.js";
import { isTauri, localFileUrl } from "../platform/studio.js";

// WebView2 里 file:// 图片加载不出来：绝对路径图片统一改走 asset protocol。
// 相对路径仍由 docBaseUrl 的 asset 基址拼接；浏览器 dev 不受影响，继续用 file://。
if (isTauri) setLocalUrlConverter(localFileUrl);

/**
 * 编辑器运行时（原 Electron 版 index.js 的改造）。
 * 外壳（侧栏/文件树/大纲/标签/状态栏）由 Vue + Pinia 接管；这里保留编辑器、
 * 命令、文档/导出/图片逻辑，以及与壳共用的命令式弹层（菜单/设置/右键菜单）。
 * 由 App.vue 挂载后调用一次，返回暴露给 Vue 组件的命令 API。
 */
export function initRuntime() {
const shell = useShellStore();

/* ---------------- 错误可见化：截图验证时能直接看到崩溃 ---------------- */

function fail(msg) {
  let el = document.getElementById("fatal");
  if (!el) {
    el = document.createElement("pre");
    el.id = "fatal";
    document.body.appendChild(el);
  }
  el.textContent += msg + "\n";
}
window.addEventListener("error", (e) =>
  fail("运行错误：" + (e.message || e.error)),
);
window.addEventListener("unhandledrejection", (e) =>
  fail(
    "Promise 错误：" +
      (e.reason && e.reason.message ? e.reason.message : e.reason),
  ),
);

/* ---------------- 语法高亮（只作用于代码块内部） ---------------- */

/* ---------------- 编辑器 ---------------- */

const host = document.getElementById("editor-host");

const state = {
  path: null,
  dir: null,
  dirty: false,
  autosave: true,
  typewriter: false,
  // 原文件的换行风格与 BOM：保存时原样还原，避免打开再保存产生整文件 diff。
  eol: "\n",
  bom: false,
  // 读取时判定的编码（utf-8 / gbk / utf-16le…），保存时按原编码写回。
  encoding: "utf-8",
};

// 撤销历史挂在这一份编辑器状态上，不挂在文件上。换文档时先卸掉再装上，
// 让字段按新状态重新创建，旧文件的记录才不会跟着映射进新文件。
const historySlot = new Compartment();

let splitPane = null;
const splitStateProxy = () => splitPane?.splitState || { path: null, dir: null, dirty: false, eol: "\n", bom: false, encoding: "utf-8" };
const getSplitView = () => splitPane?.getSplitView() || null;

function activeDocContext() {
  const sv = getSplitView();
  const ss = splitStateProxy();
  if (shell.activePane === "split" && sv && ss.path) {
    return { isSplit: true, view: sv, state: ss, save: () => splitPane.saveSplit() };
  }
  return { isSplit: false, view, state, save };
}

function activeView() {
  return activeDocContext().view;
}

function activeState() {
  return activeDocContext().state;
}

const { createEditorExtensions } = createEditorSetup({
  getPrimaryView: () => view,
  getFormatting: () => formatting,
  pickTableSize: () => pickTableSize(),
  attachImage: (buf, ext) => attachImage(buf, ext),
  insertAtCursor: (text, offset, targetView) => insertAtCursor(text, offset, targetView),
  flash: (msg) => flash(msg),
  handlePastedText: (text, targetView) => handlePastedText(text, targetView),
  copyMarkdownSelection: (v) => copyMarkdownSelection(v),
  run: (cmd) => run(cmd),
  openFile: () => openFile(),
  quickOpen: () => quickOpen(),
  newDoc: () => newDoc(),
  saveAs: () => saveAs(),
  doExportPdf: () => doExportPdf(),
  adjustFontSize,
  resetFontSize,
  jumpBack,
  jumpForward,
  showSide,
  focusFileSearch,
});

const view = new EditorView({
  parent: host,
  state: EditorState.create({
    doc: "",
    extensions: createEditorExtensions({
      historySlot,
      getDocState: () => state,
      getDocView: () => view,
      onFocus: () => focusPane("primary"),
      onUpdate: (u) => {
        if (u.docChanged) {
          setDirty(true);
          scheduleAutosave();
          if (shell.activePane === "primary") scheduleOutline();
        }
        if ((u.docChanged || u.selectionSet) && shell.activePane === "primary") scheduleStatus();
        if (u.selectionSet) {
          trackCursorJump(u);
          maybeTypewriter();
          if (shell.activePane === "primary") {
            // 光标一动，大纲里的「当前章节」也该跟着换
            requestAnimationFrame(() => syncOutlineCurrent());
          }
          const fmt = document.getElementById("fmt-pop");
          if (u.view.state.selection.main.empty) {
            if (fmt) fmt.hidden = true;
          } else if (fmt && !fmt.hidden) {
            requestAnimationFrame(() => placeFmtPop(u.view));
          }
        }
      },
    }),
  }),
});

// 调试/自检探针：外部（CDP、控制台）可直接驱动编辑器状态，验证输入触发行为。
window.__plume = view;
// 调试探针：以指定路径灌入文档（docBase 随之设置），用于验证本地图片等真实打开链路。
window.__plumeLoad = (content, pathOrName) => loadDoc(content, pathOrName);

view.focus();

function bindViewScrollSync(targetView) {
  let scrollFade = null;
  targetView.scrollDOM.addEventListener(
    "scroll",
    () => {
      targetView.scrollDOM.classList.add("is-scrolling");
      clearTimeout(scrollFade);
      scrollFade = setTimeout(
        () => targetView.scrollDOM.classList.remove("is-scrolling"),
        700,
      );
      const fmt = document.getElementById("fmt-pop");
      if (fmt) fmt.hidden = true;
    },
    { passive: true },
  );
  targetView.dom.addEventListener("mouseup", () =>
    requestAnimationFrame(() => placeFmtPop(targetView)),
  );

  // 代码块不跟着整页折行。滚动其中一行时，同一块里的其它行跟着走，只在最后一行露出滚动条。
  targetView.dom.addEventListener(
    "scroll",
    (event) => {
      const line = event.target;
      if (!(line instanceof Element) || !line.classList.contains("cm-code-line")) return;
      if (line.classList.contains("cm-fence-open") || line.classList.contains("cm-fence-close")) return;
      const group = [line];
      let node = line;
      while (
        (node = node.previousElementSibling) &&
        node.classList.contains("cm-code-line") &&
        !node.classList.contains("cm-fence-open")
      ) {
        group.push(node);
      }
      node = line;
      while (
        (node = node.nextElementSibling) &&
        node.classList.contains("cm-code-line") &&
        !node.classList.contains("cm-fence-close")
      ) {
        group.push(node);
      }
      for (const other of group) {
        if (other !== line && other.scrollLeft !== line.scrollLeft) other.scrollLeft = line.scrollLeft;
      }
    },
    true,
  );
}
bindViewScrollSync(view);

/* ---------------- 字号实时缩放与光标跳转历史 ---------------- */

function adjustFontSize(delta) {
  const cur = getAppearance().fontSize;
  const next = stepFontSize(cur, delta);
  if (next === cur) {
    flash(`正文字号已达边界：${next}px`);
    return;
  }
  updateAppearance({ fontSize: next });
  flash(`正文字号：${next}px`);
}

function resetFontSize() {
  updateAppearance({ fontSize: FONT_SIZE_DEFAULT });
  flash(`正文字号已重置：${FONT_SIZE_DEFAULT}px`);
}

let zoomTimer = null;
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    adjustFontSize(e.deltaY < 0 ? 1 : -1);
    document.body.classList.add("on-zoom");
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => document.body.classList.remove("on-zoom"), 180);
  },
  { passive: false },
);

const jumpHistory = createJumpHistory({ maxEntries: 50, minLineDelta: 5 });
let lastTrackedLoc = { path: null, pos: 0, line: 1 };

function currentJumpLoc() {
  const pos = view.state.selection.main.head;
  return {
    path: state.path,
    pos,
    line: view.state.doc.lineAt(Math.min(pos, view.state.doc.length)).number,
  };
}

function recordJumpOrigin() {
  jumpHistory.record(currentJumpLoc(), { force: true });
}

function trackCursorJump(u) {
  const loc = currentJumpLoc();
  if (!u.docChanged && !jumpHistory.isNavigating()) {
    if (
      lastTrackedLoc.path === loc.path &&
      Math.abs(loc.line - lastTrackedLoc.line) >= 5
    ) {
      jumpHistory.record(lastTrackedLoc);
    }
  }
  lastTrackedLoc = loc;
}

async function applyJumpTarget(target) {
  if (!target) return false;
  await jumpHistory.runNavigatingAsync(async () => {
    if (target.path && !samePath(target.path, state.path)) {
      if (window.studio?.readFile && (await settleCurrentDocument())) {
        try {
          const r = await window.studio.readFile(target.path);
          openDiskDoc(r);
        } catch {
          return;
        }
      } else {
        return;
      }
    }
    const pos = Math.max(0, Math.min(target.pos, view.state.doc.length));
    view.contentDOM.focus({ preventScroll: true });
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center", yMargin: 56 }),
    });
    blinkLine(view, pos);
    lastTrackedLoc = currentJumpLoc();
  });
  return true;
}

function jumpBack() {
  const target = jumpHistory.goBack(currentJumpLoc());
  if (!target) {
    flash("没有更早的光标位置");
    return false;
  }
  applyJumpTarget(target);
  return true;
}

function jumpForward() {
  const target = jumpHistory.goForward(currentJumpLoc());
  if (!target) {
    flash("没有可前进的光标位置");
    return false;
  }
  applyJumpTarget(target);
  return true;
}

/* ---------------- 状态栏 ---------------- */

function countWords(text) {
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  const rest = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ");
  const latin = (rest.match(/[A-Za-z0-9_'’-]+/g) || []).length;
  return cjk + latin;
}

let statusTimer = null;
function scheduleStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(updateStatus, 120);
}

function updateStatus(extra) {
  const { view: av, state: as } = activeDocContext();
  const text = av.state.doc.toString();
  const head = av.state.selection.main.head;
  const line = av.state.doc.lineAt(Math.max(0, Math.min(head, av.state.doc.length)));
  shell.setWordGoal(getWordGoal(as.path));
  shell.setStatus({
    words: countWords(text),
    lines: av.state.doc.lines,
    cursorLine: line.number,
    cursorCol: head - line.from + 1,
    encoding: as.encoding,
    eol: as.eol,
  });
  if (extra !== undefined) shell.setHint(extra);
}

/** 选区是否已被某对对称标记包裹（含标记在选区两侧的情形），用于格式条点亮按钮。 */
function fmtActive(marker, targetView = activeView()) {
  const s = targetView.state;
  const sel = s.selection.main;
  if (sel.empty) return false;
  const text = s.sliceDoc(sel.from, sel.to);
  const len = marker.length;
  if (text.length >= len * 2 && text.startsWith(marker) && text.endsWith(marker)) return true;
  let before = sel.from >= len && s.sliceDoc(sel.from - len, sel.from) === marker;
  let after = s.sliceDoc(sel.to, sel.to + len) === marker;
  // 单字符斜体要排除加粗：**text** 两侧各取一个 * 会误判成斜体。
  if (marker === "*") {
    before = before && s.sliceDoc(Math.max(0, sel.from - 2), sel.from) !== "**";
    after = after && s.sliceDoc(sel.to, sel.to + 2) !== "**";
  }
  return before && after;
}

const FMT_MARKERS = { bold: "**", italic: "*", strike: "~~", code: "`", highlight: "==" };

function syncFmtPopState(pop, targetView = activeView()) {
  for (const btn of pop.querySelectorAll("[data-fmt]")) {
    const marker = FMT_MARKERS[btn.dataset.fmt];
    const on = marker ? fmtActive(marker, targetView) : false;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function placeFmtPop(targetView = activeView()) {
  const pop = document.getElementById("fmt-pop");
  if (!pop || !targetView) return;
  const sel = targetView.state.selection.main;
  const inCodeBlock =
    !sel.empty &&
    getCodeFences(targetView.state).some(
      (block) =>
        !isFenceDraft(block) && sel.from >= block.from && sel.to <= block.to,
    );
  if (sel.empty || !targetView.hasFocus || inCodeBlock) {
    pop.hidden = true;
    return;
  }
  const a = targetView.coordsAtPos(sel.from);
  const b = targetView.coordsAtPos(sel.to);
  if (!a || !b) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  syncFmtPopState(pop, targetView);
  const host = targetView.scrollDOM.getBoundingClientRect();
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const width = pop.offsetWidth || 180;
  const x = Math.max(host.left + 8, Math.min(left, host.right - width - 8));
  let y = top - (pop.offsetHeight || 34) - 8;
  if (y < host.top + 4) y = Math.max(a.bottom, b.bottom) + 8;
  pop.style.left = Math.round(x) + "px";
  pop.style.top = Math.round(y) + "px";
}

function wordGoalKeyFor(path) {
  return path ? String(path).replace(/\\/g, "/").toLowerCase() : "__untitled__";
}

function readWordGoals() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORD_GOAL_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function getWordGoal(path = state.path) {
  const map = readWordGoals();
  const n = Number(map[wordGoalKeyFor(path)] || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function setWordGoalForDoc(goal, path = state.path) {
  const n = Math.max(0, Math.round(Number(goal) || 0));
  const map = readWordGoals();
  const k = wordGoalKeyFor(path);
  if (n > 0) map[k] = n;
  else delete map[k];
  try {
    localStorage.setItem(WORD_GOAL_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
  shell.setWordGoal(n);
}

function renderStatsPop() {
  const { view: av, state: as } = activeDocContext();
  const text = av.state.doc.toString();
  const chars = text.length;
  const noWs = (text.match(/\S/g) || []).length;
  const words = countWords(text);
  const lines = av.state.doc.lines;
  const mins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 400));
  const pop = document.getElementById("stats-pop");
  const row = (label, value) =>
    `<div class="stats-row"><span>${label}</span><b>${value}</b></div>`;
  const paras = countParagraphs(text);
  const goal = getWordGoal(as.path);
  shell.setWordGoal(goal);
  const gp = computeWordGoalProgress(words, goal);
  const goalStatus = gp.goal
    ? gp.reached
      ? t("stats.goalReached", { p: gp.percent })
      : t("stats.goalRemain", { p: gp.percent, r: gp.remaining.toLocaleString() })
    : t("stats.goalUnset");
  pop.innerHTML =
    `<h4>${t("stats.title")}</h4>` +
    row(t("stats.words"), words.toLocaleString()) +
    row(t("stats.chars"), chars.toLocaleString()) +
    row(t("stats.charsNoWs"), noWs.toLocaleString()) +
    row(t("stats.paragraphs"), paras.toLocaleString()) +
    row(t("stats.lines"), lines.toLocaleString()) +
    row(t("stats.readTime"), mins ? t("stats.readMins", { m: mins }) : t("stats.readLessMin")) +
    `<div class="stats-goal">` +
    `<label class="stats-goal-row"><span>${t("stats.goalLabel")}</span>` +
    `<input id="stats-goal-input" type="number" min="0" step="100" value="${gp.goal || ""}" placeholder="${t("stats.goalPlaceholder")}"></label>` +
    `<div class="stats-goal-meta"><span>${t("stats.goalProgress")}</span><b>${goalStatus}</b></div>` +
    `<div class="stats-goal-track"><div class="stats-goal-fill${gp.reached ? " is-reached" : ""}" style="width:${gp.percent}%"></div></div>` +
    `</div>`;
  const input = pop.querySelector("#stats-goal-input");
  if (input) {
    input.addEventListener("change", () => {
      setWordGoalForDoc(input.value, as.path);
      renderStatsPop();
    });
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        setWordGoalForDoc(input.value, as.path);
        renderStatsPop();
      }
    });
  }
}

document.getElementById("st-count")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = document.getElementById("stats-pop");
  if (!pop) return;
  if (!pop.hidden) {
    pop.hidden = true;
    return;
  }
  renderStatsPop();
  pop.hidden = false;
});

document.getElementById("fmt-pop")?.addEventListener("mousedown", (e) => {
  const btn =
    e.target instanceof Element ? e.target.closest("[data-fmt]") : null;
  if (!btn) return;
  e.preventDefault();
  run(btn.dataset.fmt);
});

document.addEventListener("mousedown", (e) => {
  const pop = document.getElementById("stats-pop");
  if (!pop || pop.hidden) return;
  if (e.target instanceof Element && e.target.closest("#stats-pop, #st-count"))
    return;
  pop.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const pop = document.getElementById("stats-pop");
  if (pop && !pop.hidden) pop.hidden = true;
});

const draftUI = createDraftUI({
  state,
  getView: () => view,
  loadDoc: (...args) => loadDoc(...args),
  setDirty,
  openSheet: (...args) => openSheet(...args),
  closeSettings: () => closeSettings(),
  flash: (msg) => flash(msg),
  countWords,
});
const { clearDraft, writeDraft, scheduleDraft, openDraftRecoveryModal, offerDraftRecovery } = draftUI;

function syncWindowChrome() {
  const { state: activeS } = activeDocContext();
  const ss = splitStateProxy();
  const name = activeS.path ? activeS.path.split(/[\\/]/).pop() : "未命名.md";
  window.studio?.setDirty(!!(state.dirty || ss.dirty));
  window.studio?.setTitle((activeS.dirty ? "• " : "") + name + " — Plume");
}

function setDirty(v, { preserveDraft = false } = {}) {
  state.dirty = v;
  // 变干净就把恢复草稿一起撤掉；启动初始化可选择保留上次草稿。
  if (!v) {
    shell.setSaveError("");
    if (!preserveDraft) clearDraft();
  } else scheduleDraft();
  shell.syncDoc({ path: state.path, dir: state.dir });
  shell.setDirty(v);
  syncWindowChrome();
}

/** 打开另一篇文档前的统一出口：保存、明确放弃或取消，绝不静默覆盖。 */
async function settleCurrentDocument() {
  if (!state.dirty) return true;
  if (!view.state.doc.toString().trim()) {
    clearDraft();
    return true;
  }
  let choice = "cancel";
  if (window.studio?.unsaved) choice = await window.studio.unsaved();
  else if (window.confirm("当前文档有未保存的更改。确定先保存并继续吗？")) choice = "save";
  if (choice === "cancel") return false;
  if (choice === "discard") {
    clearDraft();
    return true;
  }
  try {
    return await save();
  } catch (err) {
    flash("保存失败，已取消切换文档：" + (err?.message || err));
    return false;
  }
}

/* ---------------- 侧栏：文件树 / 目录 ---------------- */

const sidebarEl = document.getElementById("sidebar");

/** 当前视图以 DOM 上的 data-side 为准，Pinia 同步给 Vue 组件 */
function sideView() {
  return document.body.dataset.side === "files" ? "files" : "outline";
}

function setSideView(v, { persist = true } = {}) {
  document.body.dataset.side = v;
  shell.setSide(v);
  if (v === "files") shell.bumpFileTree();
}

function sidebarVisible() {
  return !document.body.classList.contains("hide-sidebar");
}

let sidebarMotion = false;
let sidebarOffTimer = null;

function setSidebar(open) {
  clearTimeout(sidebarOffTimer);
  if (open) {
    sidebarEl.classList.remove("is-off");
    if (sidebarMotion) sidebarEl.getBoundingClientRect();
    document.body.classList.remove("hide-sidebar");
  } else {
    document.body.classList.add("hide-sidebar");
    if (!sidebarMotion) sidebarEl.classList.add("is-off");
    else {
      sidebarOffTimer = setTimeout(() => {
        if (!sidebarVisible()) sidebarEl.classList.add("is-off");
      }, 320);
    }
  }
  localStorage.setItem(SIDE_OPEN_KEY, open ? "1" : "0");
  shell.setSidebar(open);
  if (open) {
    if (sideView() === "files") shell.bumpFileTree();
    else renderOutline();
  }
  view.dispatch({ effects: refreshDecorations.of(null) });
}

/** 点顶栏按钮：同一个视图再点一次 = 收起侧栏 */
function showSide(v) {
  if (sidebarVisible() && sideView() === v) setSidebar(false);
  else {
    setSideView(v);
    setSidebar(true);
  }
}

/* ---- 文件树与大纲（已抽离至 fs-ops-ui.js / outline-sync.js） ---- */

const { showContextMenu } = createContextMenu({ flash: (msg) => flash(msg) });

const fsOpsUI = createFsOpsUI({
  state,
  shell,
  getPrimaryView: () => view,
  getSplitState: splitStateProxy,
  getSplitView,
  setDirty,
  syncWindowChrome,
  settleCurrentDocument,
  settleSplitDocument: () => settleSplitDocument(),
  closeSplit: (...args) => closeSplit(...args),
  loadDoc: (...args) => loadDoc(...args),
  openDiskDoc: (...args) => openDiskDoc(...args),
  focusPane: (...args) => focusPane(...args),
  recordJumpOrigin,
  remapDocumentTabs: (...args) => remapDocumentTabs(...args),
  removeDocumentTabsUnder: (...args) => removeDocumentTabsUnder(...args),
  syncTabs: (...args) => syncTabs(...args),
  openSheet: (...args) => openSheet(...args),
  closeSettings: () => closeSettings(),
  flash: (msg) => flash(msg),
});
const {
  askText,
  createFsEntry,
  renameFsEntry,
  trashFsEntry,
  moveFsEntry,
  copyText,
  openTreePath,
  openSearchedFile,
} = fsOpsUI;

const outlineSync = createOutlineSync({
  shell,
  getActiveView: activeView,
  getPrimaryView: () => view,
  sidebarVisible,
  sideView,
  recordJumpOrigin,
});
const { scheduleOutline, renderOutline, syncOutlineCurrent, outlineJump } = outlineSync;

/* ---------------- 格式化命令 ---------------- */

const formatting = createEditorFormatting({ getActiveView: activeView });
const {
  wrap,
  setHeading,
  insertLink,
  linkifySelection,
  handlePastedText,
  insertAtCursor,
  insertFence,
  insertMathBlock,
  pickTableSize,
  insertTable,
  insertHr,
  insertToc,
  toggleLinePrefix,
  clearFormat,
} = formatting;

function headingPosBySlug(slug, targetView = activeView()) {
  const used = new Set();
  for (const h of buildOutline(targetView.state)) {
    if (slugify(h.text, used) === slug) return h.pos;
  }
  return -1;
}

/**
 * 打开链接：**Ctrl / Cmd + 点击**（Typora 的规矩）。
 * 普通点击仍然是「把光标放进文字里改」——链接在编辑器里首先是文本。
 * `#xxx` 是页内锚点，按标题跳过去，不往系统浏览器里丢；
 * 其余相对路径不做猜测（编辑器不负责当文件管理器），只提示一句。
 */
/**
 * 表格右键菜单：条目与顺序对齐 Typora（插入/移动/删除/复制/格式化/删表），
 * 末尾额外保留「编辑表格源码」和按列排序——Typora 没有，但这里一直是入口。
 * row 是视觉行号（0 = 表头），col 是列号。
 */
/** 读取指定首行行号的表格源码二维数组（[header, delim, ...body]），供多选区复制/操作使用。 */
const {
  clearAllTableSelections,
  bindViewInteractions,
  imageSourceRange,
  openLink,
} = createEditorContext({
  getPrimaryView: () => view,
  activeView,
  state,
  focusPane: (pane) => focusPane(pane),
  showContextMenu,
  flash: (msg) => flash(msg),
  copyText: (text, okMsg) => copyText(text, okMsg),
  askText: (title, initial, label, placeholderText) => askText(title, initial, label, placeholderText),
  currentImageFolder: () => currentImageFolder(),
  uploadImageFromMenu: (el) => uploadImageFromMenu(el),
  headingPosBySlug,
  recordJumpOrigin,
  run: (cmd) => run(cmd),
});
bindViewInteractions(view, "primary");

/* ---------------- 图片与图床（已抽离至 image-ops.js） ---------------- */
const imageOps = createImageOps({
  view,
  state,
  flash: (msg) => flash(msg),
  copyText,
  insertAtCursor,
  imageSourceRange,
  openSheet: (...args) => openSheet(...args),
  closeSettings: () => closeSettings(),
  run: (cmd) => run(cmd),
  save: () => save(),
});
const {
  attachImage,
  collectDocumentImages,
  currentImageFolder,
  forgetMissingPastes,
  pickImage,
  settlePastedImages,
  uploadDocumentImages,
  uploadImageFromMenu,
} = imageOps;

/* ---------------- 分栏与多标签页 / 磁盘读写（已抽离至 split-pane.js / tabs.js / file-io.js） ---------------- */

splitPane = createSplitPane({
  state,
  shell,
  getPrimaryView: () => view,
  createEditorExtensions,
  bindViewScrollSync,
  bindViewInteractions,
  samePath,
  setDirty,
  loadDoc: (...args) => loadDoc(...args),
  browserDownload: (...args) => browserDownload(...args),
  updateStatus,
  renderOutline,
  scheduleStatus,
  scheduleOutline,
  syncOutlineCurrent,
  placeFmtPop,
  syncWindowChrome,
  getTabs: () => tabs,
  flash: (msg) => flash(msg),
});
const {
  focusPane,
  settleSplitDocument,
  openSplit,
  closeSplit,
  promoteSplitToPrimary,
  swapSplit,
  reloadSplitIfNeeded,
} = splitPane;

const tabsEnabled = !new URLSearchParams(location.search).has("selftest");
let fileIO = null;
const tabs = createTabsManager({
  state,
  view,
  shell,
  samePath,
  settleCurrentDocument,
  openDiskDoc: (r, opts) => fileIO.openDiskDoc(r, opts),
  loadDoc: (c, p, opts) => fileIO.loadDoc(c, p, opts),
  flash: (msg) => flash(msg),
  tabsEnabled,
  getSplitPath: () => splitStateProxy().path,
  onBeforeCloseSplit: () => closeSplit({ settle: true }),
  onPromoteSplit: () => promoteSplitToPrimary(),
  onFocusPane: (pane) => {
    focusPane(pane);
    (pane === "split" ? getSplitView() : view)?.focus();
  },
  onRestoreSplit: (p) => openSplit(p, { focus: false }),
});
fileIO = createFileIO({
  state,
  view,
  shell,
  historySlot,
  tabs,
  samePath,
  setDirty,
  writeDraft,
  settleCurrentDocument,
  setDocBase,
  cancelCellEditor,
  forgetMissingPastes,
  settlePastedImages,
  getWordGoal,
  updateStatus,
  renderOutline,
  sidebarVisible,
  sideView,
  openSheet: (...args) => openSheet(...args),
  flash: (msg) => flash(msg),
  onDocLoaded: () => {
    lastTrackedLoc = currentJumpLoc();
  },
});

const {
  restoreSession,
  remapDocumentTabs,
  removeDocumentTabsUnder,
  syncTabs,
  openTab,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
} = tabs;
const {
  browserDownload,
  readRecent,
  loadDoc,
  openDiskDoc,
  openFile,
  openRecent,
  save,
  saveAs,
  newDoc,
  scheduleAutosave,
  reloadModifiedFiles,
} = fileIO;

/* ---------------- 导出 / 快速打开 / 设置备份（抽离模块的实例化） ---------------- */

// 导出栈（HTML/Word/RTF/LaTeX/EPUB 生成器 + KaTeX 导出样式）整体懒加载：
// 只有真正执行导出命令时才拉取，首屏 bundle 不背这部分体积。
let exportCommandsPromise = null;
function loadExportCommands() {
  return (exportCommandsPromise ??= import("./export-commands.js").then((m) =>
    m.createExportCommands({ state, view, flash, browserDownload }),
  ));
}
const doExportHtml = async () => (await loadExportCommands()).doExportHtml();
const doExportHtmlBare = async () => (await loadExportCommands()).doExportHtmlBare();
const doExportDocx = async () => (await loadExportCommands()).doExportDocx();
const doExportRtf = async () => (await loadExportCommands()).doExportRtf();
const doExportLatex = async () => (await loadExportCommands()).doExportLatex();
const doExportEpub = async () => (await loadExportCommands()).doExportEpub();
const doExportPng = async () => (await loadExportCommands()).doExportPng();
const doExportPdf = async () => (await loadExportCommands()).doExportPdf();

/* ---------------- 设置 / 主题商店 / 许可弹窗（已抽离至 settings-modal.js） ---------------- */
const {
  openSheet,
  closeSettings,
  showLicense,
  openThemeStore,
  openSettings,
  openImageSettings,
} = createSettingsModal({
  state,
  flash: (msg) => flash(msg),
  getImageOps: () => imageOps,
  exportSettings: () => exportSettings(),
  importSettings: () => importSettings(),
});

const quickOpen = createQuickOpen({
  state,
  openSheet,
  flash,
  settleCurrentDocument,
  openDiskDoc,
  openSearchHit: openSearchedFile,
  samePath,
  getCommands: buildPaletteCommands,
  getRecentFiles: () => readRecent(),
  getOpenTabs: () => tabs.documentTabs,
  runCommand: (cmd) => run(cmd),
});

const { exportSettings, importSettings } = createSettingsBackup({
  flash,
  browserDownload,
  openSettings,
  updateAppearance,
});

/* ---------------- 提示 ---------------- */

let flashTimer = null;
function flash(msg) {
  shell.setHint(msg);
}

document.addEventListener("plume-large-doc-fallback", () => {
  flash("文档超过 12,000 行，已启用视口窗口块级预览（±200 行）以保持流畅");
});

/* ---------------- 打字机模式 ---------------- */

let typewriterRaf = 0;
function maybeTypewriter() {
  if (!state.typewriter || typewriterRaf) return;
  typewriterRaf = requestAnimationFrame(() => {
    typewriterRaf = 0;
    if (!state.typewriter) return;
    const head = view.state.selection.main.head;
    view.dispatch({
      effects: EditorView.scrollIntoView(head, { y: "center" }),
    });
  });
}

/* ---------------- 拖放 ---------------- */

const mainEl = document.getElementById("main");
mainEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  mainEl.classList.add("is-dragover");
});
mainEl.addEventListener("dragleave", () =>
  mainEl.classList.remove("is-dragover"),
);
mainEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  mainEl.classList.remove("is-dragover");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (/\.(md|markdown|txt)$/i.test(file.name)) {
    if (!(await settleCurrentDocument())) return;
    // 拖进来的文件要拿到真实路径，否则「保存」只会当新文档另存
    if (window.studio && file.path) {
      try {
        const r = await window.studio.readFile(file.path);
        openDiskDoc(r);
        return;
      } catch {
        /* 读不到就退回浏览器式的纯文本导入 */
      }
    }
    loadDoc(await file.text(), file.name);
  } else if (file.type.startsWith("image/")) {
    const ext = file.name.split(".").pop() || "png";
    if (window.studio) await attachImage(await file.arrayBuffer(), ext);
    else insertAtCursor(`![](${URL.createObjectURL(file)})`);
  }
});

/* ---------------- 拼写检查与侧栏拖拽 ---------------- */

function applySpellcheck() {
  const on = !!getAppearance().spellcheck;
  if (view?.contentDOM) view.contentDOM.spellcheck = on;
  const sv = getSplitView();
  if (sv?.contentDOM) sv.contentDOM.spellcheck = on;
  window.studio?.setSpellcheck?.(on);
}

function bindSidebarSplit() {
  const split = document.getElementById("sidebar-split");
  if (!split || split.dataset.bound) return;
  split.dataset.bound = "1";
  const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
  if (saved && /^\d+px$/.test(saved.trim())) {
    document.documentElement.style.setProperty("--sidebar-width", saved.trim());
  }
  split.addEventListener("mousedown", (e) => {
    if (!sidebarVisible()) return;
    e.preventDefault();
    document.body.classList.add("sidebar-dragging");
    const move = (ev) => {
      const w = Math.max(180, Math.min(480, ev.clientX));
      document.documentElement.style.setProperty("--sidebar-width", w + "px");
    };
    const up = () => {
      document.body.classList.remove("sidebar-dragging");
      const width = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim();
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, width);
      } catch {
        /* 记不住宽度也不影响这次拖动 */
      }
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

/* ---------------- 工具栏 / 菜单 ---------------- */

const updater = createUpdater({
  openSheet,
  flash,
  settle: settleCurrentDocument,
});

async function openFolder() {
  if (!window.studio?.openFolderDialog) return;
  const dir = await window.studio.openFolderDialog();
  if (!dir) return;
  shell.setDir(dir);
  setSideView("files");
  setSidebar(true);
  shell.bumpFileTree();
}

const commands = {
  new: newDoc,
  open: openFile,
  "open-folder": openFolder,
  "quick-open": quickOpen,
  save: () => activeDocContext().save(),
  "save-as": saveAs,
  "export-html": doExportHtml,
  "export-html-bare": doExportHtmlBare,
  "export-pdf": doExportPdf,
  "export-docx": doExportDocx,
  "export-rtf": doExportRtf,
  "export-epub": doExportEpub,
  "export-latex": doExportLatex,
  "export-png": doExportPng,
  settings: openSettings,
  "theme-store": openThemeStore,
  license: showLicense,
  "close-window": () => requestClose(),
  bold: () => wrap("**"),
  italic: () => wrap("*"),
  strike: () => wrap("~~"),
  highlight: () => wrap("=="),
  code: () => wrap("`"),
  link: () => insertLink(),
  image: pickImage,
  "upload-document-images": uploadDocumentImages,
  "image-settings": openImageSettings,
  table: pickTableSize,
  toc: () => insertToc(),
  fence: () => insertFence(),
  math: () => insertMathBlock(),
  hr: () => insertHr(),
  quote: () => toggleLinePrefix(quotePrefix),
  ul: () => toggleLinePrefix(ulPrefix),
  ol: () => toggleLinePrefix(olPrefix),
  task: () => toggleLinePrefix(taskPrefix),
  "clear-format": () => clearFormat(),
  "format-spacing": () => {
    const av = activeView();
    const orig = av.state.doc.toString();
    const next = panguSpacing(orig);
    if (next === orig) {
      flash("中英文间距已规范");
      return;
    }
    const head = Math.min(av.state.selection.main.head, next.length);
    av.dispatch({
      changes: { from: 0, to: orig.length, insert: next },
      selection: { anchor: head },
    });
    flash("已为中英文混排补齐空格");
    av.focus();
  },
  undo: () => undo(activeView()),
  redo: () => redo(activeView()),
  "select-all": () => {
    const av = activeView();
    av.dispatch({ selection: { anchor: 0, head: av.state.doc.length } });
    av.focus();
  },
  find: () => {
    const av = activeView();
    openSearchPanel(av);
    av.focus();
  },
  "search-files": () => focusFileSearch(),
  "draft-recovery": () => openDraftRecoveryModal(),
  "fold-heading": () => {
    if (!foldCurrentHeading(activeView())) flash("当前位置不在可折叠的 H1–H3 章节内");
  },
  "unfold-heading": () => unfoldCurrentHeading(activeView()),
  "fold-all-headings": () => foldAllHeadings(activeView()),
  "unfold-all-headings": () => unfoldAllHeadings(activeView()),
  "view-files": () => showSide("files"),
  "view-outline": () => showSide("outline"),
  "toggle-sidebar": () => setSidebar(!sidebarVisible()),
  // 标签栏显隐：状态栏 / 视图菜单是唯一入口；偏好由 store 持久化
  "toggle-tabs": () => shell.toggleTabsVisible(),
  "source-mode": () => {
    const on = !view.state.field(sourceModeField, false);
    view.dispatch({
      effects: [setSourceMode.of(on), refreshDecorations.of(null)],
    });
    if (sv) {
      sv.dispatch({
        effects: [setSourceMode.of(on), refreshDecorations.of(null)],
      });
    }
    document.body.classList.toggle("source-mode", on);
    shell.setSourceMode(on);
    flash(on ? "源代码模式：开" : "源代码模式：关");
    activeView().focus();
  },
  focus: () => {
    const on = document.body.classList.toggle("focus-mode");
    view.dispatch({ effects: refreshDecorations.of(null) });
    getSplitView()?.dispatch({ effects: refreshDecorations.of(null) });
    flash(on ? "专注模式：开" : "专注模式：关");
  },
  typewriter: () => {
    state.typewriter = !state.typewriter;
    flash(state.typewriter ? "打字机模式：开" : "打字机模式：关");
  },
  h1: () => setHeading(1),
  h2: () => setHeading(2),
  h3: () => setHeading(3),
  h4: () => setHeading(4),
  h5: () => setHeading(5),
  h6: () => setHeading(6),
  p: () => setHeading(0),
  copy: () => copySelection(false),
  "copy-markdown": () => copyMarkdownSelection(activeView()),
  "copy-wechat": () => copyAsWeChatHtml(),
  "zoom-in": () => adjustFontSize(1),
  "zoom-out": () => adjustFontSize(-1),
  "zoom-reset": () => resetFontSize(),
  "jump-back": () => jumpBack(),
  "jump-forward": () => jumpForward(),
  cut: () => copySelection(true),
  paste: async () => {
    const av = activeView();
    try {
      const text = await navigator.clipboard.readText();
      if (!handlePastedText(text, av)) insertAtCursor(text, undefined, av);
    } catch {
      flash("无法读取剪贴板");
    }
  },
  "paste-plain": async () => {
    const av = activeView();
    try {
      const text = await navigator.clipboard.readText();
      insertAtCursor(text, undefined, av);
    } catch {
      flash("无法读取剪贴板");
    }
  },
  "save-then-close": async () => {
    const ok = await save();
    if (ok) window.studio.quit();
  },
  "theme-folder": async () => {
    const ok = await window.studio?.openThemeFolder?.();
    if (ok === false) flash("无法打开主题目录");
  },
  shortcuts: openShortcuts,
  "check-update": () => updater.checkForUpdate(),
  about: async () => {
    const info = (await window.studio?.info?.()) || {};
    showInfo({
      icon: true,
      title: "关于 Plume",
      message: `Plume ${info.version || "0.1.0"}`,
      detail:
        "Tauri + Rust + Vue + CodeMirror 6 的所见即所得 Markdown 编辑器。\n" +
        "编辑器内核是 CodeMirror 6，文件服务与目录监听由 Rust 提供。\n\n" +
        `平台 ${info.platform || "windows"} · Tauri ${info.tauri || "2"}\n\n` +
        "MIT 许可证 · 商业使用免费（保留版权声明与许可声明即可）",
    });
  },
};

/**
 * 复制 / 剪切：写入渲染后 HTML + 渲染后纯文本。
 * 读写都过 state，删完必然一致。
 */
async function copySelection(cut, targetView = activeView(), targetDir = activeState().dir) {
  const { state: s } = targetView;
  if (s.selection.main.empty) {
    flash("没有选中内容");
    return;
  }
  const { html, plain } = renderSelectionForClipboard(s, targetDir);
  if (!plain && !html) {
    flash("没有选中内容");
    return;
  }
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(plain);
    }
  } catch {
    try {
      await navigator.clipboard.writeText(plain);
    } catch {
      flash("无法写入剪贴板");
      return;
    }
  }
  if (cut) {
    targetView.dispatch(
      s.changeByRange((r) => ({
        changes: { from: r.from, to: r.to, insert: "" },
        range: EditorSelection.cursor(r.from),
      })),
    );
  }
  targetView.focus();
}

/**
 * 复制为 Markdown 源码（Ctrl+Shift+C）。
 */
async function copyMarkdownSelection(v) {
  const targetView = v || activeView();
  const s = targetView.state;
  const parts = s.selection.ranges
    .map((r) => s.sliceDoc(r.from, r.to))
    .filter(Boolean);
  if (!parts.length) {
    flash("没有选中内容");
    return false;
  }
  try {
    await navigator.clipboard.writeText(parts.join("\n"));
    flash("已复制为 Markdown");
    return true;
  } catch {
    flash("无法写入剪贴板");
    return false;
  }
}

/**
 * 一键复制为公众号 / 飞书 / 邮件富文本 HTML（复用当前主题 CSS 变量生成全内联样式）。
 */
async function copyAsWeChatHtml(targetView = activeView(), targetDir = activeState().dir) {
  const s = targetView.state;
  const sel = s.selection.main;
  const md = sel.empty ? s.doc.toString() : s.sliceDoc(sel.from, sel.to);
  if (!md.trim()) {
    flash("当前内容为空");
    return false;
  }
  const themeId = currentThemeId();
  const themeMeta = THEMES.find((it) => it.id === themeId);
  const { html, plain } = await renderWeChatHtml(md, {
    themeId,
    imageResolver: (srcUrl) => resolveImageForClipboard(srcUrl, targetDir),
  });
  try {
    if (window.ClipboardItem) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
    } else {
      await navigator.clipboard.writeText(html);
    }
    flash(`已复制为公众号 / 富文本样式（${themeMeta?.label || themeId}）`);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(html);
      flash(`已复制富文本 HTML（${themeMeta?.label || themeId}）`);
      return true;
    } catch {
      flash("无法写入剪贴板");
      return false;
    }
  }
}

/** 结构化快捷键面板：分组标题 + 「键位 / 说明」网格，不再是一长串点号文本 */
function openShortcuts() {
  openSheet(
    t("menu.shortcuts"),
    (body) => {
      body.classList.add("shortcut-sheet");
      const groups = document.createElement("div");
      groups.className = "shortcut-groups";
      for (const g of shortcutGroups()) {
        const section = document.createElement("section");
        section.className = "shortcut-group";
        const title = document.createElement("h3");
        title.textContent = g.group;
        section.appendChild(title);
        const list = document.createElement("div");
        list.className = "shortcut-list";
        for (const item of g.items) {
          const row = document.createElement("div");
          row.className = "shortcut-row";
          const key = document.createElement("kbd");
          key.className = "shortcut-key";
          key.textContent = item.keys || "";
          const label = document.createElement("span");
          label.className = "shortcut-label";
          label.textContent = item.label;
          row.append(key, label);
          list.appendChild(row);
        }
        section.appendChild(list);
        groups.appendChild(section);
      }
      const notes = document.createElement("section");
      notes.className = "shortcut-notes";
      const noteTitle = document.createElement("h3");
      noteTitle.textContent = t("shortcuts.notes");
      notes.appendChild(noteTitle);
      const noteList = document.createElement("ul");
      for (const text of shortcutNotes()) {
        const li = document.createElement("li");
        li.textContent = text;
        noteList.appendChild(li);
      }
      notes.appendChild(noteList);
      body.append(groups, notes);
    },
    { wide: true },
  );
}

/** 桌面端用系统消息框（原生），浏览器里退化成 alert */
async function showInfo(payload) {
  if (window.studio?.showInfo) {
    await window.studio.showInfo(payload);
    return;
  }
  alert(`${payload.message}\n\n${payload.detail || ""}`);
}

function run(cmd) {
  if (!cmd) return;
  if (cmd.startsWith("theme:")) {
    applyTheme(cmd.slice(6));
    return;
  }
  if (cmd.startsWith("appearance:")) {
    applyAppearanceCommand(cmd.slice("appearance:".length));
    return;
  }
  if (cmd.startsWith("recent:")) {
    openRecent(readRecent()[Number(cmd.slice(7))]);
    return;
  }
  const fn = commands[cmd];
  if (!fn) return;
  try {
    const result = fn();
    if (result && typeof result.catch === "function") {
      result.catch((err) => flash("操作失败：" + (err?.message || err)));
    }
  } catch (err) {
    flash("操作失败：" + (err?.message || err));
  }
}

document.querySelectorAll("[data-cmd]").forEach((el) => {
  el.addEventListener("click", () => run(el.dataset.cmd));
});

window.studio?.onCommand(run);
fileIO.bindExternalChange();

/* ---------------- 菜单栏 ---------------- */

const isSourceMode = () => !!view.state.field(sourceModeField, false);

const MENUS = createMenus({
  readRecent,
  sidebarVisible,
  sideView,
  shell,
  isSourceMode,
  state,
});

const menubar = createMenubar({
  bar: document.getElementById("menubar"),
  pop: document.getElementById("menu-pop"),
  menus: MENUS,
  run: (cmd) => run(cmd),
  backLabel: t("menu.back"),
});

// 菜单收起后把焦点还给编辑器，和原生菜单一致
document.addEventListener("menubar:closed", () => activeView().focus());
// 语言切换：菜单栏顶栏按钮与打开中的菜单页重读文案（Vue 组件靠响应式自动更新）
document.addEventListener("locale-change", () => menubar.refreshLabels());
document.addEventListener("appearance-change", applySpellcheck);
document.getElementById("settings-close")?.addEventListener("click", closeSettings);
document.getElementById("settings")?.addEventListener("mousedown", (e) => {
  if (e.target.id === "settings") closeSettings();
});
bindSidebarSplit();

/* ---------------- 启动 ---------------- */

(async () => {
  await initTheme();
  bindThemeEditorView(view);
  // katex 懒加载就绪后重算装饰：公式从源码占位变成渲染结果（widget 的 eq 含就绪标记）。
  onTexReady(() => {
    view.dispatch({ effects: refreshDecorations.of(null) });
    getSplitView()?.dispatch({ effects: refreshDecorations.of(null) });
  });
  const qs = new URLSearchParams(location.search);

  // 自绘顶栏 + 自绘窗口三键（Tauri 没有 titleBarOverlay，按钮由 TitleBar.vue 绘制）
  if (window.studio) document.body.classList.add("is-desktop");

  if (qs.get("theme")) await applyTheme(qs.get("theme"), { silent: true });
  renderOutline();

  // 恢复上次的侧栏状态；URL 里可以直接指定 ?side=files|outline|none
  const sideParam = qs.get("side");
  setSideView(
    sideParam === "files" || sideParam === "outline" ? sideParam : sideView(),
    { persist: !sideParam },
  );
  setSidebar(
    sideParam
      ? sideParam !== "none"
      : localStorage.getItem(SIDE_OPEN_KEY) !== "0",
  );

  setDirty(false, { preserveDraft: true });
  requestAnimationFrame(() => {
    sidebarMotion = true;
    document.body.classList.add("motion-ready");
  });
  // 初始把光标放在文末，但视图停在顶部：打开文档先看到渲染效果
  view.dispatch({
    selection: { anchor: view.state.doc.length },
    effects: EditorView.scrollIntoView(0, { y: "start" }),
  });

  // 恢复上次会话的标签与活动文档；随后 ?doc / 命令行文件 / 草稿恢复会叠加在其上。
  if (!qs.get("selftest") && window.studio) await restoreSession();

  // ?doc=<绝对路径> 直接打开一篇文档（截图 / 联调用）
  if (qs.get("doc") && window.studio) {
    try {
      const r = await window.studio.readFile(qs.get("doc"));
      openDiskDoc(r);
    } catch {
      /* 路径不对就当没传 */
    }
  }

  // 文件关联「打开方式」/双击文档：冷启动时命令行传入的初始文件，优先于草稿恢复
  const initialFile = window.studio?.takeInitialFile
    ? await window.studio.takeInitialFile()
    : null;
  if (initialFile && window.studio) {
    try {
      const r = await window.studio.readFile(initialFile);
      openDiskDoc(r);
    } catch (err) {
      flash("打开失败：" + (err?.message || err));
    }
  }

  if (!qs.get("selftest") && !qs.get("doc") && !initialFile)
    await offerDraftRecovery();

  if (qs.get("focus")) run("focus");
  if (qs.get("source")) run("source-mode");

  // 调试/截图用：把光标放进某段文字里，验证「光标所在处才显形源码」这类行为。
  // 用 y:'center' 而不是 scrollIntoView:true —— 后者只要「露出一点」就算完成，
  // 想截目标附近的完整版面（比如表格下面的内容）时会停在半截上。
  if (qs.get("at")) {
    const pos = view.state.doc.toString().indexOf(qs.get("at"));
    if (pos >= 0) {
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
    }
  }

  // 调试/截图用：?sel=<起点>,<终点> 直接把一段选区摆出来。
  // 「选区在代码块里看不见」这类问题只有截图才说得清，光靠断言量不出视觉效果。
  if (qs.get("sel")) {
    const [a, b] = qs
      .get("sel")
      .split(",")
      .map((n) => parseInt(n, 10));
    if (Number.isFinite(a) && Number.isFinite(b)) {
      view.dispatch({
        selection: { anchor: a, head: b },
        effects: EditorView.scrollIntoView(Math.min(a, b), { y: "center" }),
      });
    }
  }

  // ?debug=1 把内部句柄挂到 window，供 scripts/probe.js 之类的外部核查用
  if (qs.get("debug"))
    window.__studio = {
      view,
      run,
      menubar,
      state,
      commands,
      ACCEL,
      detectCode,
      pasteAsCodeBlock,
      handlePastedText,
    };

  // 调试/截图用：展开指定菜单（file/edit/para/format/view/theme/help）
  if (qs.get("menu")) {
    const id = qs.get("menu");
    setTimeout(() => menubar.open(id), 220);
  }

  // 调试/截图用：直接把第一个表格单元格的就地编辑器打开
  if (qs.get("celledit")) {
    const pos = view.state.doc.toString().indexOf("| 能力 |");
    if (pos >= 0) {
      view.dispatch({
        effects: EditorView.scrollIntoView(pos, { y: "center" }),
      });
      // 表格 widget 是异步渲染的，可能还在滚动中就被点到，所以失败就重试
      const tryOpen = (n) => {
        const td = document.querySelector(".cm-table-wrap tbody td");
        if (!td) {
          if (n < 25) setTimeout(() => tryOpen(n + 1), 100);
          return;
        }
        td.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
        if (!document.querySelector(".cm-cell-editor") && n < 25)
          setTimeout(() => tryOpen(n + 1), 120);
      };
      setTimeout(() => tryOpen(0), 260);
    }
  }

  // 调试/截图用：把第一个代码块的语言选择弹层打开（弹层只有交互时才出现，截不到）
  if (qs.get("langmenu")) {
    const at = view.state.doc.toString().indexOf("```");
    if (at >= 0)
      view.dispatch({
        effects: EditorView.scrollIntoView(at, { y: "center" }),
      });
    const tryOpen = (n) => {
      const chip = document.querySelector(".cm-fence-chip");
      if (!chip) {
        if (n < 25) setTimeout(() => tryOpen(n + 1), 100);
        return;
      }
      chip.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    };
    setTimeout(() => tryOpen(0), 300);
  }

  if (qs.get("selftest")) {
    // 打开时是空白文档。自检仍用原来的示例稿，避免每条断言都去找一篇不存在的欢迎页。
    const { WELCOME } = await import("./welcome.js");
    loadDoc(WELCOME, null);
    // 自检自己崩掉时不能一声不响：以前异常会变成一条没人看的 unhandled rejection，
    // 外部只能读到「未完成」，分不清是「还没跑完」还是「跑挂了」。
    try {
      const { runSelfTest } = await import("./selftest.js");
      // openDoc 给自检用：侧栏 / 文件树要基于真实目录才能验证
      await runSelfTest(view, {
        applyTheme,
        // 导出栈懒加载：自检里按需取模块，调用点已改为 await
        exportHtml: async (...a) => (await import("./markdown-export.js")).exportHtml(...a),
        exportHtmlReady: async (...a) => (await import("./markdown-export.js")).exportHtmlReady(...a),
        setDirty,
        writeDraft,
        clearDraft,
        settleCurrentDocument,
        openDoc: loadDoc,
        docPath: () => state.path,
        run,
        // 这两个需要「页面外」的能力（开系统浏览器 / 读剪贴板），自检里没法真按一下，
        // 所以把入口交过去直接调，验的是同一段逻辑
        openLink,
        linkifySelection,
        detectCode,
        pasteAsCodeBlock,
        handlePastedText,
      });
    } catch (e) {
      const box = document.createElement("div");
      box.id = "selftest";
      const h = document.createElement("h3");
      h.textContent = "自检中断：" + ((e && e.message) || e);
      const pre = document.createElement("pre");
      pre.className = "st-extra";
      pre.textContent = String((e && e.stack) || e);
      box.append(h, pre);
      document.body.appendChild(box);
      console.error("[selftest]", e);
    }
  }
})();

/* ---------------- Tauri 原生拖放与窗口关闭 ---------------- */

/** Tauri 的原生拖放给出真实路径（dragDropEnabled 时 HTML5 drop 不触发）。 */
async function handleDroppedPaths(paths) {
  if (!paths || !paths.length) return;
  const doc = paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
  if (doc) {
    if (splitStateProxy().path && samePath(doc, splitStateProxy().path)) {
      focusPane("split");
      getSplitView()?.focus();
      return;
    }
    if (!(await settleCurrentDocument())) return;
    try {
      const r = await window.studio.readFile(doc);
      openDiskDoc(r);
    } catch (err) {
      flash("打开失败：" + (err?.message || err));
    }
    return;
  }
  const img = paths.find((p) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p));
  if (img && window.studio) {
    try {
      const bytes = await window.studio.readFileBytes(img);
      await attachImage(bytes.buffer, img.split(".").pop() || "png");
    } catch (err) {
      flash("图片读取失败：" + (err?.message || err));
    }
  }
}
if (window.studio?.onNativeDrop) window.studio.onNativeDrop(handleDroppedPaths);

/** 未保存文档的三态询问（保存/不保存/取消），与设置面板同一视觉。 */
function askUnsaved() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openSheet(
      t("unsaved.title"),
      (body, close) => {
        const text = document.createElement("p");
        text.className = "settings-note";
        text.textContent = t("unsaved.question");
        const hint = document.createElement("p");
        hint.className = "settings-note";
        hint.textContent = t("unsaved.hint");

        // Typora 式排布：主操作靠左（保存 / 不保存），取消单独靠右。
        const row = document.createElement("div");
        row.className = "ask-actions";
        const main = document.createElement("div");
        main.className = "ask-group";
        const side = document.createElement("div");
        side.className = "ask-group";
        for (const [label, value, kind, group] of [
          [t("unsaved.saveAndClose"), "save", "primary", main],
          [t("unsaved.discard"), "discard", "danger", main],
          [t("unsaved.cancel"), "cancel", "ghost", side],
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
        row.append(main, side);
        body.append(text, hint, row);
      },
      { onClose: () => done("cancel") },
    );
  });
}
window.__plumeUnsaved = askUnsaved;

/** 统一的关闭出口：先处理未保存文档，再真正退出。 */
async function requestClose() {
  if ((await settleCurrentDocument()) && (await settleSplitDocument())) {
    window.studio?.quit();
  }
}
if (window.studio?.onCloseRequested) window.studio.onCloseRequested(requestClose);

// 应用已运行时，再次通过「打开方式」/双击文档：单实例回调把路径转发到这里，在同一窗口打开。
if (window.studio?.onOpenFile) {
  window.studio.onOpenFile(async (path) => {
    if (path) await openTreePath(path);
  });
}

/* ---------------- 暴露给 Vue 外壳的命令 API ---------------- */

// 启动后静默检查一次更新：只在打包后的 Tauri 壳里跑，开发/自检环境不打扰。
// 失败（离线、仓库尚未发版）不提示；发现新版才弹安装面板。
if (isTauri && !import.meta.env.DEV) {
  setTimeout(() => updater.checkForUpdate({ silent: true }), 8000);
}

function focusFileSearch() {
  setSidebar(true);
  setSideView("files");
  requestAnimationFrame(() => {
    const input = document.getElementById("file-search-input");
    if (input) {
      input.focus();
      input.select();
    }
  });
}

async function reloadAllModifiedFiles(paths) {
  await reloadModifiedFiles(paths);
  await reloadSplitIfNeeded(paths);
}

return {
  run,
  openPath: openTreePath,
  openFolder,
  reloadModifiedFiles: reloadAllModifiedFiles,
  openSearchHit: openSearchedFile,
  openTab,
  closeTab,
  closeOtherTabs,
  closeTabsToRight,
  openSplit,
  closeSplit,
  swapSplit,
  focusPane,
  outlineJump,
  refreshOutline: renderOutline,
  selectSide: (v) => {
    if (sidebarVisible() && sideView() === v) return;
    setSideView(v);
    if (!sidebarVisible()) setSidebar(true);
  },
  fileOps: {
    create: createFsEntry,
    rename: renameFsEntry,
    trash: trashFsEntry,
    move: moveFsEntry,
    copyText,
  },
  contextMenu: showContextMenu,
  handleDroppedPaths,
  requestClose,
};
}
