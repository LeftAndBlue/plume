import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { codeSelectionFit } from "./selection-fit.js";
import { caretFit, dropCursor } from "./caret-fit.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Autolink } from "@lezer/markdown";
import { codeLanguages } from "./code-languages.js";
import {
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";

import {
  blockDecorations,
  livePreview,
  refreshDecorations,
  setSourceMode,
  sourceModeField,
} from "./live-preview.js";
import { getCodeFences, isFenceDraft } from "./code-fences.js";
import { buildOutline } from "./outline.js";
import { plainInline, onTexReady } from "./inline-text.js";
import {
  autoPair,
  deleteEmptyFence,
  deletePair,
  deletePairForward,
  deleteInlinePair,
  exitHeadingOnBackspace,
  exitHeadingOnDelete,
  exitListOnBackspace,
  exitQuoteOnBackspace,
  fenceOnEnter,
  fenceDeletionGuard,
  navigateFence,
  protectFenceBackspace,
  protectFenceDelete,
  selectCodeBlock,
} from "./pairing.js";
import { detectCode, pasteAsCodeBlock } from "./paste-code.js";
import { renderSelectionForClipboard } from "./clipboard.js";
import { createMenubar } from "./menubar.js";
import {
  ACCEL,
  shortcutGroups,
  shortcutNotes,
} from "./shortcuts.js";
import { slugify } from "./slugify.js";
import { createQuickOpen } from "./quick-open.js";
import { createSettingsBackup } from "./settings-backup.js";
import { createUpdater } from "../platform/updater.js";
import { t, setLocale, LOCALES, i18n } from "../i18n.js";
import { withTrailingBlank, detectDocFormat, serializeForDisk } from "./doc-format.js";
import {
  DRAFT_KEY,
  SIDE_KEY,
  SIDE_OPEN_KEY,
  SIDEBAR_WIDTH_KEY,
  IMAGE_FOLDER_KEY,
  IMAGE_UPLOAD_MODE_KEY,
  IMAGE_UPLOAD_PROVIDER_KEY,
  PICGO_URL_KEY,
  EASYIMAGE_URL_KEY,
  EASYIMAGE_TOKEN_KEY,
  RECENT_KEY,
  SESSION_KEY,
} from "./storage-keys.js";
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
import {
  blinkLine,
  editingImageField,
  formatImageMd,
  parseImageMd,
  setDocBase,
  setEditingImage,
  setLocalUrlConverter,
} from "./widgets.js";
import {
  buildTableMarkdown,
  deleteTableCol,
  deleteTableRow,
  insertTableCol,
  insertTableRow,
  moveTableCol,
  moveTableRow,
  setAlign,
  sortTableRows,
} from "./table-model.js";
import { openTablePicker } from "./table-picker.js";
import {
  clearTableSelection,
  paintTableSelection,
  selectedCols,
  selectedRows,
  setTableSelection,
  tableSelectionBounds,
} from "./table-selection.js";
import { cancelCellEditor, commitCellEditor, editTable, formatTable } from "./table-edit.js";
import { normalizeMarkdownText, parseImageAttrs, splitTableRow } from "./rich-doc.js";
import { useShellStore } from "../stores/shell.js";
import { docBaseUrl, isTauri, localFileUrl } from "../platform/studio.js";

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

const codeHighlight = HighlightStyle.define([
  /**
   * markdown 的标记符（###、>、-、**、反引号、链接括号）不是「注释」。
   * lezer 把 HeaderMark / QuoteMark / ListMark / EmphasisMark / CodeMark 统一标成
   * processingInstruction，而它在 @lezer/highlight 里挂在 meta 底下 ——
   * 于是被下面那条 [tags.meta, tags.comment] 接住，光标踩到标题上、源码显形时，
   * 看到的是一小撮浅灰斜体，认不出是几个井号。
   * 这里单独给它一条：中性灰、正常字重、不斜体，读得出「这是标记」而不是「这是标题的一部分」。
   */
  {
    tag: tags.processingInstruction,
    color: "var(--text-muted)",
    fontStyle: null,
    fontWeight: "400",
  },
  { tag: tags.keyword, color: "var(--syn-keyword)" },
  { tag: [tags.name, tags.propertyName, tags.macroName], color: "var(--syn-name)" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "var(--syn-func)" },
  {
    tag: [tags.constant(tags.name), tags.standard(tags.name), tags.atom, tags.bool],
    color: "var(--syn-const)",
  },
  {
    tag: [tags.typeName, tags.className, tags.number, tags.namespace],
    color: "var(--syn-type)",
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.special(tags.string),
    ],
    color: "var(--syn-op)",
  },
  {
    tag: [tags.meta, tags.comment],
    color: "var(--syn-comment)",
    fontStyle: "italic",
  },
  { tag: [tags.string, tags.inserted], color: "var(--syn-string)" },
  { tag: tags.invalid, color: "var(--syn-invalid)" },
]);

const zhPhrases = EditorState.phrases.of({
  Find: "查找",
  Replace: "替换",
  next: "下一个",
  previous: "上一个",
  all: "全部",
  "match case": "区分大小写",
  regexp: "正则",
  "by word": "整词",
  replace: "替换",
  "replace all": "全部替换",
  close: "关闭",
  "current match": "当前匹配",
  "Go to line": "跳到行",
  "go to line": "跳到行",
  "Find next": "查找下一个",
});

/* ---------------- 编辑器 ---------------- */

const host = document.getElementById("editor-host");

const editingTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size, 16px)" },
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    lineHeight: "var(--line-height, 1.75)",
  },
  ".cm-content": { caretColor: "var(--caret)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--caret)",
    borderLeftWidth: "2px",
    borderRadius: "1px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
    {
      backgroundColor: "var(--sel-bg) !important",
    },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-selectionMatch": { backgroundColor: "var(--match-bg)" },
  ".cm-searchMatch": {
    backgroundColor: "var(--match-bg)",
    outline: "1px solid var(--match-border)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--match-bg-strong)",
  },
  ".cm-panels": { background: "var(--panel-bg)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { padding: "10px 12px", fontFamily: "var(--font-ui)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
    {
      fontFamily: "var(--font-ui)",
      fontSize: "12.5px",
    },
  ".cm-panel.cm-search input[type=text]": {
    background: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    padding: "4px 8px",
    marginRight: "6px",
  },
  ".cm-panel.cm-search button": {
    background: "var(--btn-bg)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    padding: "4px 10px",
    cursor: "pointer",
  },
  ".cm-panel.cm-search label": {
    color: "var(--text-muted)",
    marginRight: "8px",
  },
  ".cm-button": { backgroundImage: "none" },
});

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

const view = new EditorView({
  parent: host,
  state: EditorState.create({
    doc: "",
    extensions: [
      historySlot.of(history()),
      // 正文最后一行一旦写上字，下面立刻再留一行空行，不用先按回车才有地方可点。
      // 这个换行必须并进同一次事务。若另起一条 addToHistory:false 的事务，
      // 插入点刚好落在本次修改的末尾时，历史映射会把这次修改整个丢掉，
      // 粘到最后一行之后 Ctrl+Z 就撤不回来。
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr;
        const last = tr.newDoc.line(tr.newDoc.lines);
        if (!last.text) return tr;
        const nl = ChangeSet.of(
          { from: tr.newDoc.length, insert: "\n" },
          tr.newDoc.length,
        );
        return tr.startState.update({
          changes: tr.changes.compose(nl),
          selection: tr.selection,
          effects: tr.effects,
          annotations: tr.annotations,
          scrollIntoView: tr.scrollIntoView,
          filter: false,
        });
      }),
      // drawRangeCursor: false —— CM 默认会在「有选区时」再额外画一个闪烁的光标在选区末端，
      // 选区停在那儿不动它也一直闪，很吵。Typora 选中文字时只有高亮、没有光标。
      drawSelection({ drawRangeCursor: false }),
      // 正文光标跟这一行的字，代码块光标只跟代码行高，两套互不借用。
      caretFit,
      // 代码块里的多行选区只铺在代码文字上，不盖行号和行尾空白。
      codeSelectionFit,
      autoPair,
      /**
       * 粘贴必须在 CM 自带的 paste 处理器之前接管。
       * CM 的 computeHandlers 是先塞插件的 domEventHandlers、最后才塞内置处理器，
       * 我们返回 true 就会 preventDefault 并 break，内置插入不会发生。
       * 以前这些逻辑挂在 document 的冒泡监听上 —— 那时 CM 早把文本插进去了、选区也没了，
       * 「选中文字 + 粘贴链接」在真实 Ctrl+V 下其实根本不生效。
       */
      Prec.highest(
        EditorView.domEventHandlers({
          // 注意签名是 (event, view)：CM 内部用 handler.call(plugin, event, view) 调。
          // 写反了会在第一行就静默放手，粘贴全部落到内置处理器里。
          paste(event, v) {
            const data = event.clipboardData;
            if (!data) return false;
            const items = data.items ? [...data.items] : [];
            const image = items.find(
              (it) => it.type && it.type.startsWith("image/"),
            );
            if (image) {
              event.preventDefault();
              const file = image.getAsFile();
              if (file) {
                const ext = (image.type.split("/")[1] || "png").replace(
                  "jpeg",
                  "jpg",
                );
                (async () => {
                  if (window.studio)
                    await attachImage(await file.arrayBuffer(), ext);
                  else {
                    insertAtCursor(`![](${URL.createObjectURL(file)})`);
                    flash("浏览器模式下图片不会落盘");
                  }
                })();
              }
              return true;
            }
            if (handlePastedText(data.getData("text/plain"))) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          copy(event, v) {
            const sel = v.state.selection;
            if (sel.main.empty || !event.clipboardData) return false;
            const { html, plain } = renderSelectionForClipboard(v.state, state.dir);
            if (!plain && !html) return false;
            event.preventDefault();
            event.clipboardData.setData("text/plain", plain);
            event.clipboardData.setData("text/html", html);
            return true;
          },
          cut(event, v) {
            const sel = v.state.selection;
            if (sel.main.empty || !event.clipboardData) return false;
            const { html, plain } = renderSelectionForClipboard(v.state, state.dir);
            if (!plain && !html) return false;
            event.preventDefault();
            event.clipboardData.setData("text/plain", plain);
            event.clipboardData.setData("text/html", html);
            v.dispatch(
              v.state.changeByRange((r) => ({
                changes: { from: r.from, to: r.to, insert: "" },
                range: EditorSelection.cursor(r.from),
              })),
            );
            return true;
          },
        }),
      ),
      dropCursor(),
      // 按住 Alt 拖动能按列选出多行；Ctrl+点击再加一支光标
      rectangularSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      /**
       * 结构键（回车续标记、Tab 调列表层级）必须排在 markdown() 之前。
       * markdown({addKeymap:true}) 自带 insertNewlineContinueMarkup，它同样抢 Enter，
       * 且行为与我们不一致：在空的引用行上回车，它会留下一个光秃秃的 `>` 再补一行 `> `，
       * 而 Typora 是直接退出引用。谁先绑定谁生效，所以这里用 Prec.high 明确压过去。
       */
      Prec.high(
        keymap.of([
          // ``` + 回车：补出结尾围栏，光标停在中间（手不用离开键盘）
          // 代码块里 Ctrl+A 先选这块代码；已经全选再按一次才选整篇
          { key: "Mod-a", run: selectCodeBlock },
          { key: "Mod-Shift-c", run: (v) => { copyMarkdownSelection(v); return true; } },
          { key: "Enter", run: fenceOnEnter },
          { key: "Enter", run: continueList },
          { key: "Enter", run: continueQuote },
          { key: "Enter", run: newlineAfterLazyQuote },
          { key: "Tab", run: (v) => indentList(v, 1) },
          { key: "Shift-Tab", run: (v) => indentList(v, -1) },
          // 跨过零高度的隐藏围栏，不让光标困在代码块首尾。
          { key: "ArrowLeft", run: (v) => navigateFence(v, "left") },
          { key: "ArrowRight", run: (v) => navigateFence(v, "right") },
          { key: "ArrowUp", run: (v) => navigateFence(v, "up") },
          { key: "ArrowDown", run: (v) => navigateFence(v, "down") },
          // 空标题整行只有 #，退格要直接拆掉，不能只去吃上一行的换行
          { key: "Backspace", run: exitHeadingOnBackspace },
          { key: "Delete", run: exitHeadingOnDelete },
          // 空代码块再按删除：首尾围栏与空正文一次成对删掉
          { key: "Backspace", run: deleteEmptyFence },
          { key: "Backspace", run: exitListOnBackspace },
          // 空引用行一次删整行；光标在引用正文开头时退一级引用，不再留下裸 >
          { key: "Backspace", run: exitQuoteOnBackspace },
          { key: "Delete", run: deleteEmptyFence },
          // 非空块的围栏不能被误删成残片；源代码模式不拦截原始编辑
          {
            key: "Backspace",
            run: (v) => (isSourceMode() ? false : protectFenceBackspace(v)),
          },
          {
            key: "Delete",
            run: (v) => (isSourceMode() ? false : protectFenceDelete(v)),
          },
          // 空配对里按退格删掉一对，别留个孤儿括号；Delete 对称，同样整对删除
          { key: "Backspace", run: deletePair },
          { key: "Delete", run: deletePairForward },
          // 行内代码/强调的边界标记也成对删：删一侧时另一侧一起去掉（内容保留），
          // 剩下的标记不会和后文的同类符号错配，把大段正文吞成行内代码
          { key: "Backspace", run: (v) => deleteInlinePair(v, false) },
          { key: "Delete", run: (v) => deleteInlinePair(v, true) },
        ]),
      ),
      markdown({
        base: markdownLanguage,
        codeLanguages,
        addKeymap: true,
        // GFM 的裸 URL 自动链接（https://...、www....），Ctrl+点击才能打开
        extensions: [Autolink],
      }),
      syntaxHighlighting(codeHighlight),
      highlightSelectionMatches(),
      search({ top: true }),
      zhPhrases,
      // 放在 blockDecorations 之前：后者初始化时要读它的值
      sourceModeField,
      editingImageField,
      fenceDeletionGuard,
      blockDecorations,
      livePreview,
      EditorView.lineWrapping,
      placeholder("开始写点什么…"),
      editingTheme,
      keymap.of([
        { key: "Mod-s", run: () => (save(), true) },
        { key: "Mod-o", run: () => (openFile(), true) },
        { key: "Mod-Shift-p", run: () => (quickOpen(), true) },
        { key: "Mod-b", run: () => (wrap("**"), true) },
        { key: "Mod-i", run: () => (wrap("*"), true) },
        { key: "Mod-k", run: () => (insertLink(), true) },
        { key: "Mod-Shift-k", run: () => (insertFence(), true) },
        { key: "Mod-Shift-m", run: () => (insertMathBlock(), true) },
        { key: "Mod-Shift-t", run: () => (run("table"), true) },
        { key: "Mod-1", run: () => (setHeading(1), true) },
        { key: "Mod-2", run: () => (setHeading(2), true) },
        { key: "Mod-3", run: () => (setHeading(3), true) },
        { key: "Mod-4", run: () => (setHeading(4), true) },
        { key: "Mod-5", run: () => (setHeading(5), true) },
        { key: "Mod-6", run: () => (setHeading(6), true) },
        { key: "Mod-0", run: () => (setHeading(0), true) },
        { key: "Mod-Shift-1", run: () => (showSide("outline"), true) },
        { key: "Mod-Shift-e", run: () => (showSide("files"), true) },
        { key: "Mod-n", run: () => (newDoc(), true) },
        { key: "Mod-Shift-s", run: () => (saveAs(), true) },
        { key: "Mod-p", run: () => (doExportPdf(), true) },
        { key: "Mod-e", run: () => (wrap("`"), true) },
        { key: "Mod-Shift-x", run: () => (wrap("~~"), true) },
        // historyKeymap 里 Ctrl+Shift+Z 只是 mac 变体，Windows 上要自己补一条（Ctrl+Y 仍然可用）
        { key: "Mod-Shift-z", run: () => (redo(view), true) },
        // Ctrl+V 交给 Chromium 原生粘贴，纯文本走我们自己的实现（它会读到富文本/图片）
        { key: "Mod-Shift-v", run: () => (run("paste-plain"), true) },
        // 源代码模式：markdown 没有「注释」概念，Mod-/ 不会和 defaultKeymap 抢
        { key: "Mod-/", run: () => (run("source-mode"), true) },
        // 列表续行 / Tab 调层级在文件顶部用 Prec.high 绑定（要压过 markdown() 自带的 Enter）
        { key: "F1", run: () => (run("shortcuts"), true) },
        { key: "F8", run: () => (run("focus"), true) },
        { key: "F9", run: () => (run("typewriter"), true) },
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          setDirty(true);
          scheduleAutosave();
          scheduleOutline();
        }
        if (u.docChanged || u.selectionSet) scheduleStatus();
        if (u.selectionSet) {
          maybeTypewriter();
          // 光标一动，大纲里的「当前章节」也该跟着换
          requestAnimationFrame(() => syncOutlineCurrent());
          const fmt = document.getElementById("fmt-pop");
          if (view.state.selection.main.empty) {
            if (fmt) fmt.hidden = true;
          } else if (fmt && !fmt.hidden) {
            requestAnimationFrame(placeFmtPop);
          }
        }
      }),
    ],
  }),
});

// 调试/自检探针：外部（CDP、控制台）可直接驱动编辑器状态，验证输入触发行为。
window.__plume = view;
// 调试探针：以指定路径灌入文档（docBase 随之设置），用于验证本地图片等真实打开链路。
window.__plumeLoad = (content, pathOrName) => loadDoc(content, pathOrName);

view.focus();

let scrollFade = null;
view.scrollDOM.addEventListener(
  "scroll",
  () => {
    view.scrollDOM.classList.add("is-scrolling");
    clearTimeout(scrollFade);
    scrollFade = setTimeout(
      () => view.scrollDOM.classList.remove("is-scrolling"),
      700,
    );
    const fmt = document.getElementById("fmt-pop");
    if (fmt) fmt.hidden = true;
  },
  { passive: true },
);
view.dom.addEventListener("mouseup", () => requestAnimationFrame(placeFmtPop));

// 代码块不跟着整页折行。滚动其中一行时，同一块里的其它行跟着走，只在最后一行露出滚动条。
view.dom.addEventListener(
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

let zoomTimer = null;
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    document.body.classList.add("on-zoom");
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => document.body.classList.remove("on-zoom"), 180);
  },
  { passive: true },
);

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
  const text = view.state.doc.toString();
  shell.setStatus({ words: countWords(text), lines: view.state.doc.lines });
  if (extra !== undefined) shell.setHint(extra);
}

/** 选区是否已被某对对称标记包裹（含标记在选区两侧的情形），用于格式条点亮按钮。 */
function fmtActive(marker) {
  const s = view.state;
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

function syncFmtPopState(pop) {
  for (const btn of pop.querySelectorAll("[data-fmt]")) {
    const marker = FMT_MARKERS[btn.dataset.fmt];
    const on = marker ? fmtActive(marker) : false;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

function placeFmtPop() {
  const pop = document.getElementById("fmt-pop");
  if (!pop) return;
  const sel = view.state.selection.main;
  const inCodeBlock =
    !sel.empty &&
    getCodeFences(view.state).some(
      (block) =>
        !isFenceDraft(block) && sel.from >= block.from && sel.to <= block.to,
    );
  if (sel.empty || !view.hasFocus || inCodeBlock) {
    pop.hidden = true;
    return;
  }
  const a = view.coordsAtPos(sel.from);
  const b = view.coordsAtPos(sel.to);
  if (!a || !b) {
    pop.hidden = true;
    return;
  }
  pop.hidden = false;
  syncFmtPopState(pop);
  const host = view.scrollDOM.getBoundingClientRect();
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const width = pop.offsetWidth || 180;
  const x = Math.max(host.left + 8, Math.min(left, host.right - width - 8));
  let y = top - (pop.offsetHeight || 34) - 8;
  if (y < host.top + 4) y = Math.max(a.bottom, b.bottom) + 8;
  pop.style.left = Math.round(x) + "px";
  pop.style.top = Math.round(y) + "px";
}

function renderStatsPop() {
  const text = view.state.doc.toString();
  const chars = text.length;
  const noWs = (text.match(/\S/g) || []).length;
  const words = countWords(text);
  const lines = view.state.doc.lines;
  const mins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 400));
  const pop = document.getElementById("stats-pop");
  const row = (label, value) =>
    `<div class="stats-row"><span>${label}</span><b>${value}</b></div>`;
  pop.innerHTML =
    "<h4>文档统计</h4>" +
    row("字数", words.toLocaleString()) +
    row("字符", chars.toLocaleString()) +
    row("字符（不含空格）", noWs.toLocaleString()) +
    row("行数", lines.toLocaleString()) +
    row("阅读时间", mins ? `约 ${mins} 分钟` : "不到 1 分钟");
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

let autosaveTimer = null;
let draftTimer = null;
// 启动初始化会把当前空白文档标成干净；先把上次草稿读出来，避免初始化误清掉。
const STARTUP_DRAFT = (() => {
  try {
    return localStorage.getItem(DRAFT_KEY);
  } catch {
    return null;
  }
})();

function clearDraft() {
  clearTimeout(draftTimer);
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* 存储不可用时，内存编辑不受影响 */
  }
}

function writeDraft() {
  clearTimeout(draftTimer);
  if (!state.dirty) return;
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        path: state.path,
        content: view.state.doc.toString(),
        eol: state.eol,
        bom: state.bom,
        encoding: state.encoding,
        updatedAt: Date.now(),
      }),
    );
  } catch {
    /* 配额不足或隐私模式下退化为普通未保存提示 */
  }
}

function scheduleDraft() {
  clearTimeout(draftTimer);
  if (state.dirty) draftTimer = setTimeout(writeDraft, 700);
}

function setDirty(v, { preserveDraft = false } = {}) {
  state.dirty = v;
  // 变干净就把待落的自动保存和恢复草稿一起撤掉；启动初始化可选择保留上次草稿。
  if (!v) {
    clearTimeout(autosaveTimer);
    shell.setSaveError("");
    if (!preserveDraft) clearDraft();
  } else scheduleDraft();
  shell.syncDoc({ path: state.path, dir: state.dir });
  shell.setDirty(v);
  const name = state.path ? state.path.split(/[\\/]/).pop() : "未命名.md";
  window.studio?.setDirty(v);
  window.studio?.setTitle((v ? "• " : "") + name + " — Plume");
}

/** 打开另一篇文档前的统一出口：保存、明确放弃或取消，绝不静默覆盖。 */
async function settleCurrentDocument() {
  if (!state.dirty) return true;
  // 空白文档没有可保存的内容：直接关闭/切换，不弹未保存询问，也别留下空白恢复草稿。
  // 已有文件被删空时不保存只是丢弃编辑，原文件内容不变。
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

async function offerDraftRecovery() {
  let draft = null;
  try {
    draft = JSON.parse(STARTUP_DRAFT || "null");
  } catch {
    clearDraft();
    return;
  }
  if (!draft || typeof draft.content !== "string") return;
  const restore = window.studio?.confirm
    ? await window.studio.confirm("检测到上次未保存的草稿，是否恢复？")
    : window.confirm("检测到上次未保存的草稿，是否恢复？");
  if (!restore) {
    clearDraft();
    return;
  }
  loadDoc(draft.content, typeof draft.path === "string" ? draft.path : null);
  // 草稿正文是 LF 快照，恢复时沿用崩溃前记录的换行风格、BOM 与编码。
  if (draft.eol === "\r\n" || draft.eol === "\n") state.eol = draft.eol;
  if (typeof draft.bom === "boolean") state.bom = draft.bom;
  if (typeof draft.encoding === "string" && draft.encoding) state.encoding = draft.encoding;
  setDirty(true);
  writeDraft();
  flash("已恢复未保存草稿");
}

window.addEventListener("beforeunload", () => {
  if (state.dirty) writeDraft();
});

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

/* ---- 文件树 ---- */

function samePath(a, b) {
  if (!a || !b) return false;
  return (
    a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()
  );
}

async function askText(title, initial = "", fieldLabel = "名称", placeholder = "") {
  return new Promise((resolve) => {
    const ph = placeholder ? ` placeholder="${String(placeholder).replace(/"/g, "&quot;")}"` : "";
    openSheet(
      title,
      `<label class="settings-row"><span>${String(fieldLabel).replace(/</g, "&lt;")}</span><input id="ask-text-value" type="text"${ph} value="${String(initial).replace(/"/g, "&quot;")}"></label>` +
        `<div class="settings-actions"><button id="ask-text-ok" class="settings-btn">确定</button><button id="ask-text-cancel" class="settings-btn">取消</button></div>`,
    );
    const input = document.getElementById("ask-text-value");
    const finish = (value) => {
      closeSettings();
      resolve(value);
    };
    document.getElementById("ask-text-ok")?.addEventListener("click", () => finish(input ? input.value.trim() : null), { once: true });
    document.getElementById("ask-text-cancel")?.addEventListener("click", () => finish(null), { once: true });
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(input ? input.value.trim() : null);
      if (e.key === "Escape") finish(null);
    });
    input?.focus();
    input?.select();
  });
}

async function createFsEntry(dir, directory) {
  if (!state.dir || !window.studio?.createFsEntry) return flash("请先打开一个文档目录");
  const name = await askText(directory ? "新建文件夹" : "新建 Markdown 文档", directory ? "新建文件夹" : "未命名.md");
  if (!name) return;
  try {
    await window.studio.createFsEntry(state.dir, dir, name, directory);
    shell.bumpFileTree();
    flash(directory ? "文件夹已创建" : "文档已创建");
  } catch (err) {
    flash("创建失败：" + (err?.message || err));
  }
}

function currentInsideEntry(entry) {
  if (!state.path) return false;
  if (samePath(state.path, entry.path)) return true;
  if (!entry.dir) return false;
  const norm = (p) => String(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(state.path).startsWith(norm(entry.path) + "\\") || norm(state.path).startsWith(norm(entry.path) + "/");
}

async function renameFsEntry(entry) {
  const name = await askText("重命名", entry.name);
  if (!name || name === entry.name) return;
  if (currentInsideEntry(entry) && !(await settleCurrentDocument())) return;
  try {
    const oldPath = state.path;
    const renamed = await window.studio.renameFsEntry(state.dir, entry.path, name);
    if (currentInsideEntry(entry) && oldPath) {
      state.path = renamed + oldPath.slice(entry.path.length);
      window.studio?.watchDocument?.(state.path);
      setDirty(false);
    }
    remapDocumentTabs(entry.path, renamed);
    syncTabs();
    shell.bumpFileTree();
    flash("已重命名");
  } catch (err) {
    flash("重命名失败：" + (err?.message || err));
  }
}

async function trashFsEntry(entry) {
  const ok = window.studio?.confirm
    ? await window.studio.confirm(`确定把「${entry.name}」移到回收站吗？`)
    : window.confirm(`确定把「${entry.name}」移到回收站吗？`);
  if (!ok) return;
  const contained = currentInsideEntry(entry);
  if (contained && !(await settleCurrentDocument())) return;
  try {
    await window.studio.trashFsEntry(state.dir, entry.path);
    if (contained) {
      loadDoc("", null);
      removeDocumentTabsUnder(entry.path);
      syncTabs();
    }
    shell.bumpFileTree();
    flash("已移到回收站");
  } catch (err) {
    flash("删除失败：" + (err?.message || err));
  }
}

async function moveFsEntry(source, destDir) {
  const contained = currentInsideEntry({ path: source, dir: true });
  if (contained && !(await settleCurrentDocument())) return;
  const oldPath = state.path;
  try {
    const moved = await window.studio.moveFsEntry(state.dir, source, destDir);
    if (contained && oldPath) {
      state.path = moved + oldPath.slice(source.length);
      window.studio?.watchDocument?.(state.path);
      setDirty(false);
    }
    remapDocumentTabs(source, moved);
    syncTabs();
    shell.bumpFileTree();
    flash("已移动");
  } catch (err) {
    flash("移动失败：" + (err?.message || err));
  }
}

let closeActiveContextMenu = () => {};

async function copyText(text, success = "已复制") {
  try {
    await navigator.clipboard.writeText(String(text || ""));
    flash(success);
    return true;
  } catch {
    flash("无法写入剪贴板");
    return false;
  }
}

/** 右键菜单里的线性图标（stroke 用 currentColor，尺寸交给 CSS）。 */
function menuIcon(kind) {
  const paths = {
    cut: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><line x1="20" y1="4" x2="8.1" y2="15.9"/><line x1="14.4" y1="14.4" x2="20" y2="20"/><line x1="8.1" y1="8.1" x2="12" y2="12"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    paste:
      '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
    trash:
      '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.4"/><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L12.5 19.6"/>',
  };
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("fill", "none");
  el.setAttribute("stroke", "currentColor");
  el.setAttribute("stroke-width", "1.7");
  el.setAttribute("stroke-linecap", "round");
  el.setAttribute("stroke-linejoin", "round");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = paths[kind] || "";
  return el;
}

function showContextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  closeActiveContextMenu();
  const openMenus = [];
  const close = () => {
    for (const m of openMenus) m.remove();
    openMenus.length = 0;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", keys, true);
    window.removeEventListener("resize", close);
    if (closeActiveContextMenu === close) closeActiveContextMenu = () => {};
  };
  const outside = (e) => {
    if (!openMenus.some((m) => m.contains(e.target))) close();
  };
  const keys = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  function createMenu(menuItems, isSubmenu = false) {
    const menu = document.createElement("div");
    menu.className = "ft-context app-context" + (isSubmenu ? " sub-context" : "");
    menu.setAttribute("role", "menu");
    openMenus.push(menu);

    let activeChildMenu = null;
    let activeChildAnchor = null; // 当前子菜单挂在哪个父条目上
    let hoverTimer = null;
    let closeTimer = 0;

    /** 收起当前二级菜单（只移除这一层，主菜单不动）。 */
    const closeSubmenu = () => {
      clearTimeout(closeTimer);
      if (!activeChildMenu) return;
      const idx = openMenus.indexOf(activeChildMenu);
      if (idx >= 0) openMenus.splice(idx, 1);
      activeChildMenu.remove();
      activeChildMenu = null;
      activeChildAnchor = null;
    };

    // 鼠标移出菜单就收起二级菜单；给 200ms 缓冲，方便斜着从父项移到子菜单里
    menu.addEventListener("mouseleave", () => {
      if (!activeChildMenu) return;
      closeTimer = setTimeout(closeSubmenu, 200);
    });
    menu.addEventListener("mouseenter", () => clearTimeout(closeTimer));
    // 停在菜单空白处（既不在父项也不在别的条目上）同样收起
    menu.addEventListener("mouseover", (e) => {
      if (!activeChildMenu || !activeChildAnchor) return;
      if (activeChildAnchor.contains(e.target)) return;
      closeSubmenu();
    });

    for (const item of menuItems.filter(Boolean)) {
      if (item.separator) {
        const sep = document.createElement("div");
        sep.className = "context-sep";
        menu.appendChild(sep);
        continue;
      }
      // 网格行：Typora 那种一排图标 / 一排按钮的面板，而不是一条条往下排
      if (Array.isArray(item.grid)) {
        const grid = document.createElement("div");
        grid.className = "context-grid";
        grid.style.gridTemplateColumns = `repeat(${item.cols || 4}, minmax(0, 1fr))`;
        for (const tile of item.grid.filter(Boolean)) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "context-tile" + (tile.cls ? " " + tile.cls : "");
          b.title = tile.title || tile.label || "";
          b.dataset.contextAction = tile.label || tile.title || "";
          b.disabled = !!tile.disabled;
          if (tile.icon) b.appendChild(menuIcon(tile.icon));
          if (tile.label) {
            const text = document.createElement("span");
            text.textContent = tile.label;
            b.appendChild(text);
          }
          b.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          // 移到图标/按钮格上，说明不是在挑二级菜单，顺手收起
          b.addEventListener("mouseenter", () => {
            clearTimeout(hoverTimer);
            closeSubmenu();
          });
          b.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (b.disabled) return;
            close();
            tile.action?.();
          });
          grid.appendChild(b);
        }
        menu.appendChild(grid);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.disabled = !!item.disabled;
      btn.dataset.contextAction = item.label;
      if (item.danger) btn.classList.add("is-danger");

      const labelWrap = document.createElement("span");
      labelWrap.className = "context-label";
      if (item.checked) {
        const check = document.createElement("span");
        check.className = "context-check";
        check.textContent = "✓ ";
        labelWrap.appendChild(check);
      }
      labelWrap.appendChild(document.createTextNode(item.label));
      btn.appendChild(labelWrap);

      // 快捷键提示右对齐（Typora 的菜单都带这个），没有就留空
      if (item.accel) {
        const accel = document.createElement("span");
        accel.className = "context-accel";
        accel.textContent = item.accel;
        btn.appendChild(accel);
      }

      const hasChildren = Array.isArray(item.children) && item.children.length > 0;
      if (hasChildren) {
        const arrow = document.createElement("span");
        arrow.className = "context-arrow";
        arrow.textContent = "›";
        btn.appendChild(arrow);

        const openSubmenu = () => {
          closeSubmenu();
          const sub = createMenu(item.children, true);
          document.body.appendChild(sub);
          const btnRect = btn.getBoundingClientRect();
          let left = btnRect.right + 4;
          let top = btnRect.top - 6;
          const subRect = sub.getBoundingClientRect();
          if (left + subRect.width > window.innerWidth - 8) {
            left = Math.max(8, btnRect.left - subRect.width - 2);
          }
          if (top + subRect.height > window.innerHeight - 8) {
            top = Math.max(8, window.innerHeight - subRect.height - 8);
          }
          sub.style.left = left + "px";
          sub.style.top = top + "px";
          // 鼠标进了子菜单就取消父级的收起定时；离开子菜单再延迟收起
          sub.addEventListener("mouseenter", () => clearTimeout(closeTimer));
          sub.addEventListener("mouseleave", () => {
            closeTimer = setTimeout(closeSubmenu, 200);
          });
          activeChildMenu = sub;
          activeChildAnchor = btn;
        };

        btn.addEventListener("mouseenter", () => {
          clearTimeout(hoverTimer);
          hoverTimer = setTimeout(openSubmenu, 120);
        });
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          openSubmenu();
        });
      } else {
        btn.addEventListener("mouseenter", () => {
          clearTimeout(hoverTimer);
          closeSubmenu();
        });
        btn.addEventListener("click", () => {
          close();
          Promise.resolve(item.action?.()).catch((err) => flash("操作失败：" + (err?.message || err)));
        });
      }
      menu.appendChild(btn);
    }
    return menu;
  }

  const mainMenu = createMenu(items);
  document.body.appendChild(mainMenu);
  const rect = mainMenu.getBoundingClientRect();
  // 右下各让 6px：菜单不贴着点击处（表格单元格）出现，视觉上留一道缝
  const x = event.clientX + 6;
  const y = event.clientY + 6;
  mainMenu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
  mainMenu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
  closeActiveContextMenu = close;
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", keys, true);
    window.addEventListener("resize", close);
  }, 0);
  return mainMenu;
}

async function openTreePath(path) {
  if (!(await settleCurrentDocument())) return;
  try {
    const r = await window.studio.readFile(path);
    openDiskDoc(r);
  } catch (err) {
    flash("打开失败：" + (err?.message || err));
  }
}

async function openSearchedFile(hit) {
  if (!(await settleCurrentDocument())) return;
  try {
    const r = await window.studio.readFile(hit.path);
    openDiskDoc(r);
    if (hit.line > 1) {
      const line = view.state.doc.line(Math.min(hit.line, view.state.doc.lines));
      const anchor = Math.min(line.to, line.from + Math.max(0, hit.col || 0));
      view.dispatch({
        selection: { anchor },
        scrollIntoView: true,
      });
      blinkLine(view, line.from);
    }
  } catch (err) {
    flash("打开失败：" + (err && err.message ? err.message : err));
  }
}

/* ---------------- 大纲（Vue OutlinePanel 渲染，这里负责数据与当前章节计算） ---------------- */

let outlineTimer = null;

function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(renderOutline, 200);
}

/* 大纲条目（pos/parent），当前章节计算用；展示数据在 Pinia 里 */
let outlineItems = [];
let outlineSpyBound = false;
let outlineMeasurePending = false;
/** 折叠状态以 Pinia 为准（组件切换后调 refreshOutline 重算）。 */
let outlineCollapsed = new Set();

function outlineKeys(items) {
  const stack = [];
  const counts = new Map();
  return items.map((it) => {
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop();
    const parent = stack.map((s) => s.level + ":" + s.text).join("/");
    const id = parent + "|" + it.level + ":" + it.text;
    const n = counts.get(id) || 0;
    counts.set(id, n + 1);
    stack.push({ level: it.level, text: it.text });
    return id + "#" + n;
  });
}

function outlineMeta(items, keys) {
  const stack = [];
  return items.map((it, i) => {
    while (stack.length && items[stack[stack.length - 1]].level >= it.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : -1;
    const hidden = stack.some((idx) => outlineCollapsed.has(keys[idx]));
    const hasChild = i + 1 < items.length && items[i + 1].level > it.level;
    stack.push(i);
    return { parent, hidden, hasChild, key: keys[i] };
  });
}

/**
 * 纯读：当前章节在 outlineItems 里的下标（-1 = 还在第一个标题之上）。
 * 光标在视口里时跟光标所在的那一节。只看视口顶的话，点最后一项时那一行
 * 到不了窗口顶（下面没有足够的正文把它顶上去），高亮会停在更上面的标题。
 */
function currentHeadingIndex() {
  const head = view.state.selection.main.head;
  const scroller = view.scrollDOM;
  const top = scroller.scrollTop;
  const bottom = top + scroller.clientHeight;
  const max = view.state.doc.length;
  const headBlock = view.lineBlockAt(Math.min(head, max));
  const caretVisible = headBlock.bottom > top + 2 && headBlock.top < bottom - 2;
  if (caretVisible) {
    let cur = -1;
    for (let i = 0; i < outlineItems.length; i++) {
      if (outlineItems[i].pos <= head) cur = i;
      else break;
    }
    return cur;
  }
  let cur = -1;
  const atEnd = top + scroller.clientHeight >= scroller.scrollHeight - 2;
  const probe = atEnd ? bottom - 8 : top + 8;
  for (let i = 0; i < outlineItems.length; i++) {
    const blk = view.lineBlockAt(Math.min(outlineItems[i].pos, max));
    if (blk.top <= probe) cur = i;
    else break;
  }
  return cur;
}

function paintOutlineCurrent(cur) {
  // 当前项被折叠时点亮最近的可见父级；可见性与滚动跟随由 OutlinePanel 负责。
  let shown = cur;
  const items = shell.outlineItems;
  while (shown >= 0 && items[shown]?.hidden) shown = outlineItems[shown].parent;
  shell.setOutlineCurrent(shown);
}

/**
 * 滚动/移光标后点亮当前章节。
 * 读 layout 必须走 requestMeasure：直接在 scroll 回调里调 lineBlockAt 会把估算值写进
 * CM 的高度图，随后测量周期又把 scrollTop 拉回去——实测滚动会卡死在文档顶部，
 * 目录点跳、滚到代码块都跟着失效。
 */
function syncOutlineCurrent() {
  if (!outlineItems.length || outlineMeasurePending) return;
  if (!sidebarVisible() || sideView() !== "outline") return;
  outlineMeasurePending = true;
  view.requestMeasure({
    read: () => {
      outlineMeasurePending = false;
      return currentHeadingIndex();
    },
    write: (cur) => paintOutlineCurrent(cur),
  });
}

function bindOutlineSpy() {
  if (outlineSpyBound) return;
  outlineSpyBound = true;
  view.scrollDOM.addEventListener("scroll", syncOutlineCurrent, {
    passive: true,
  });
}

function renderOutline() {
  outlineCollapsed = new Set(
    Object.keys(shell.outlineCollapsed).filter((k) => shell.outlineCollapsed[k]),
  );
  const items = buildOutline(view.state);
  const meta = outlineMeta(items, outlineKeys(items));
  outlineItems = items.map((it, i) => ({ pos: it.pos, parent: meta[i].parent }));
  shell.setOutline(
    items.map((it, i) => ({
      level: it.level,
      text: it.text,
      pos: it.pos,
      key: meta[i].key,
      parent: meta[i].parent,
      hasChild: meta[i].hasChild,
      hidden: meta[i].hidden,
    })),
  );
  bindOutlineSpy();
  syncOutlineCurrent();
}

/** 大纲点击跳转（OutlinePanel 调用）：中间的标题放到正文区正中。 */
function outlineJump(pos, index) {
  const y = index === 0 ? "start" : "center";
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y, yMargin: 8 }),
  });
  view.contentDOM.focus({ preventScroll: true });
  blinkLine(view, pos);
}

/* ---------------- 格式化命令 ---------------- */

// 从序号或圆点开始拖选时，CM 的选区会包含 Markdown 列表前缀。
// 行内格式只能包正文：`**1. 文本**` 会把整项变成普通段落，列表也就消失了。
const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;

function inlineWrapSpans(state, range) {
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(Math.max(range.from, range.to - 1));
  const spans = [];
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n);
    const prefix = LIST_PREFIX.exec(line.text);
    const contentFrom = line.from + (prefix ? prefix[0].length : 0);
    const from = Math.max(range.from, contentFrom);
    const to = Math.min(range.to, line.to);
    if (to > from) spans.push({ from, to });
  }
  return spans;
}

// 逐项生成行内修改，并把选区映射回修改后的正文。makeChange 返回的
// contentFrom/contentTo 是正文在 insert 里的偏移，支持包裹、原样保留和解包。
function changeInlineSpans(state, range, makeChange, spans = inlineWrapSpans(state, range)) {
  if (!spans.length) return { range };
  const changes = [];
  let delta = 0;
  let newFrom = null;
  let newTo = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const selected = state.sliceDoc(span.from, span.to);
    const change = makeChange(span, selected, i);
    const from = change.from + delta + change.contentFrom;
    const to = change.from + delta + change.contentTo;
    if (newFrom === null) newFrom = from;
    newTo = to;
    if (change.insert !== state.sliceDoc(change.from, change.to)) {
      changes.push({ from: change.from, to: change.to, insert: change.insert });
    }
    delta += change.insert.length - (change.to - change.from);
  }
  return { changes, range: EditorSelection.range(newFrom, newTo) };
}

function wrapRange(state, range, marker, markerEnd) {
  return changeInlineSpans(state, range, (span, selected) => ({
    from: span.from,
    to: span.to,
    insert: marker + selected + markerEnd,
    contentFrom: marker.length,
    contentTo: marker.length + selected.length,
  }));
}

// 对称标记（**、~~、== 等）的切换：已有标记则取消，没有则包裹。
function toggleWrapRange(state, range, marker) {
  const len = marker.length;
  const spans = inlineWrapSpans(state, range);
  if (!spans.length) return { range };
  const kinds = spans.map((span) => {
    const selected = state.sliceDoc(span.from, span.to);
    if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) return 'outer';
    const before = span.from >= len && state.sliceDoc(span.from - len, span.from) === marker;
    const after = state.sliceDoc(span.to, span.to + len) === marker;
    // 跨项包裹后的选区从第一项正文开始、到最后一项正文结束，
    // 因而第一项会带上自己的结束标记，后续行也可能带上开始标记。
    if (before && selected.length > len && selected.endsWith(marker)) return 'trailing';
    if (after && selected.length > len && selected.startsWith(marker)) return 'leading';
    return before && after ? 'around' : null;
  });
  // 全部已有标记时统一取消；混合选区只补未包裹部分，不再嵌套已有标记。
  const unwrapAll = kinds.every(Boolean);
  return changeInlineSpans(state, range, (span, selected, i) => {
    const kind = kinds[i];
    if (kind && unwrapAll) {
      if (kind === 'outer') {
        const text = selected.slice(len, -len);
        return { from: span.from, to: span.to, insert: text, contentFrom: 0, contentTo: text.length };
      }
      if (kind === 'trailing') {
        const text = selected.slice(0, -len);
        return { from: span.from - len, to: span.to, insert: text, contentFrom: 0, contentTo: text.length };
      }
      if (kind === 'leading') {
        const text = selected.slice(len);
        return { from: span.from, to: span.to + len, insert: text, contentFrom: 0, contentTo: text.length };
      }
      return {
        from: span.from - len,
        to: span.to + len,
        insert: selected,
        contentFrom: 0,
        contentTo: selected.length,
      };
    }
    if (kind) {
      return { from: span.from, to: span.to, insert: selected, contentFrom: 0, contentTo: selected.length };
    }
    return {
      from: span.from,
      to: span.to,
      insert: marker + selected + marker,
      contentFrom: len,
      contentTo: len + selected.length,
    };
  }, spans);
}

function wrap(marker, markerEnd = marker) {
  const { state: s } = view;
  // 双字符对称标记（加粗 **、删除线 ~~、高亮 ==）支持再次点击取消。
  const toggleable = marker === markerEnd && marker.length === 2;
  view.dispatch(
    s.changeByRange((range) => {
      const text = s.sliceDoc(range.from, range.to);
      if (!text && range.empty) {
        // 光标停在空标记对中间再按一次，取消这对标记而不是继续叠加。
        if (toggleable && range.from >= marker.length &&
          s.sliceDoc(range.from - marker.length, range.from) === marker &&
          s.sliceDoc(range.from, range.from + marker.length) === marker) {
          return {
            changes: { from: range.from - marker.length, to: range.from + marker.length, insert: '' },
            range: EditorSelection.cursor(range.from - marker.length),
          };
        }
        const insert = marker + markerEnd;
        return {
          changes: { from: range.from, insert },
          range: EditorSelection.cursor(range.from + marker.length),
        };
      }
      return toggleable ? toggleWrapRange(s, range, marker) : wrapRange(s, range, marker, markerEnd);
    }),
  );
  view.focus();
}

function applyLinePrefix(prefixFn) {
  const { state: s } = view;
  const lines = new Set();
  for (const r of s.selection.ranges) {
    const a = s.doc.lineAt(r.from).number;
    const b = s.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  const nos = [...lines].sort((x, y) => x - y);
  const changes = [];
  for (const n of nos) {
    const line = s.doc.line(n);
    const matched = /^\s{0,3}#{1,6}\s+/.exec(line.text);
    const oldLen = matched ? matched[0].length : 0;
    const stripped = line.text.slice(oldLen);
    const next = prefixFn(stripped);
    const newPrefix = next.slice(0, next.length - stripped.length);
    if (next !== line.text) {
      changes.push({ from: line.from, to: line.from + oldLen, insert: newPrefix });
    }
  }
  if (!changes.length) return;
  const changeSet = s.changes(changes);
  const selection = EditorSelection.create(
    s.selection.ranges.map((r) =>
      EditorSelection.range(
        changeSet.mapPos(r.anchor, 1),
        changeSet.mapPos(r.head, 1),
      ),
    ),
    s.selection.mainIndex,
  );
  view.dispatch({ changes: changeSet, selection, scrollIntoView: true });
  view.focus();
}

function setHeading(level) {
  applyLinePrefix((text) =>
    level === 0 ? text : "#".repeat(level) + " " + text,
  );
}

function insertLink() {
  const { state: s } = view;
  const suffix = '](https://)';
  view.dispatch(
    s.changeByRange((range) => {
      if (range.empty) {
        const text = '链接文字';
        const insert = `[${text}${suffix}`;
        return {
          changes: { from: range.from, insert },
          range: EditorSelection.range(range.from + 1, range.from + 1 + text.length),
        };
      }
      return wrapRange(s, range, '[', suffix);
    }),
  );
  // 链接文字和 URL 都可能需要编辑，但默认先替换占位 URL 更顺手。
  const labelEnd = view.state.selection.main.to;
  if (view.state.sliceDoc(labelEnd, labelEnd + suffix.length) === suffix) {
    view.dispatch({ selection: { anchor: labelEnd + 2, head: labelEnd + suffix.length - 1 } });
  }
  view.focus();
}

/**
 * 选中文字后粘贴一个裸链接 → 直接变成 `[文字](链接)`（Typora 的行为）。
 * 只认「整段剪贴板就是一个 URL」，普通文本粘贴完全不受影响。
 */
function linkifySelection(raw) {
  const url = String(raw || '').trim();
  if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) return false;
  const { state: s } = view;
  const sel = s.selection.main;
  if (sel.empty) return false;
  const label = s.sliceDoc(sel.from, sel.to);
  if (!label.trim() || /\n/.test(label)) return false;
  // 选区本身就是 URL（插入链接后选中的 https:// 占位符、已有链接的地址）时，
  // 粘贴新 URL 应当直接替换地址。再包一层会变成 [https://](新地址) 的嵌套坏链接，永远打不开。
  if (/^(https?:\/\/|mailto:)\S*$/i.test(label.trim()) || /^www\.\S*$/i.test(label.trim())) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: url },
      selection: { anchor: sel.from + url.length },
    });
    view.focus();
    return true;
  }
  view.dispatch(s.changeByRange((range) => wrapRange(s, range, '[', `](${url})`)));
  view.focus();
  return true;
}

/** 整段剪贴板是一个远程图片地址时，返回原始 URL；普通网页链接不在此列。 */
function remoteImageUrl(raw) {
  const url = String(raw || "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // 只看 pathname，查询参数和 hash 不会干扰扩展名判断。
    if (!/\.(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|webp)$/i.test(parsed.pathname)) return "";
    return url;
  } catch {
    return "";
  }
}

/** 裸图片 URL 粘贴为 Markdown 图片；独占一行时由现有块级 widget 立即显示预览。 */
function pasteRemoteImage(raw, { sourceMode = false } = {}) {
  const url = remoteImageUrl(raw);
  const sel = view.state.selection.main;
  if (!url || sourceMode || view.state.readOnly || !sel.empty) return false;
  // 代码、链接地址和图片地址里应当粘贴 URL 原文，不能嵌套出坏 Markdown。
  for (let n = syntaxTree(view.state).resolveInner(sel.head, -1); n; n = n.parent) {
    if (["FencedCode", "CodeBlock", "CodeText", "InlineCode", "Link", "Image", "Autolink", "HTMLTag"].includes(n.name)) {
      return false;
    }
  }
  // 尖括号兼容中文、空格等非 ASCII/特殊字符；<> 本身必须编码，避免截断地址。
  const dest = url.replace(/</g, "%3C").replace(/>/g, "%3E");
  insertAtCursor(`![](<${dest}>)`);
  return true;
}

/**
 * 一段剪贴板纯文本进来，先走「Typora 式的三条捷径」：
 *   1. 选中文字 + 裸链接 → [文字](链接)
 *   2. 裸图片 URL → Markdown 图片并立即预览
 *   3. 一段代码（SQL / 程序）→ 带语言标记的围栏代码块
 * 都不适用就返回 false，让 CM 按普通文本粘。菜单里的「粘贴」也走这里，两条路径行为一致。
 */
function handlePastedText(text) {
  if (!text) return false;
  if (view.hasFocus && linkifySelection(text)) return true;
  const sourceMode = !!view.state.field(sourceModeField, false);
  if (pasteRemoteImage(text, { sourceMode })) return true;
  return pasteAsCodeBlock(view, text, { sourceMode });
}

/**
 * 按导出时那套 slug 规则，找出 `#锚点` 落在哪个标题上。
 * 复用 slugify 而不是另写一份：导出的目录能跳，编辑器里 Ctrl+点击也得能跳到同一处。
 */
function headingPosBySlug(slug) {
  const used = new Set();
  for (const h of buildOutline(view.state)) {
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
function tableContextItems(wrap, cell) {
  const info = cell?._cell;
  if (!info) return [];
  const lineNo = info.tableLine;
  const row = info.row;
  const col = info.col;
  const lastRow = Math.max(0, (info.rows || 1) - 1);
  const colCount = info.cols || 1;
  const bounds = tableSelectionBounds(lineNo);
  const selRows = selectedRows(lineNo);
  const selCols = selectedCols(lineNo);
  const manyRows = selRows.length > 1;
  const manyCols = selCols.length > 1;
  // 结构改动后源码长度变了，旧选区坐标会失效，统一在改完就清掉
  const act = (mutate) => () => {
    clearTableSelection(lineNo);
    return editTable(view, lineNo, mutate);
  };
  const select = (anchor, head) => () => {
    setTableSelection(lineNo, anchor, head);
    paintTableSelection(wrap, lineNo);
  };
  const copyTable = () => {
    const from = Number(wrap.dataset.from);
    const to = Number(wrap.dataset.to);
    const full = view.state.doc.sliceString(from, to);
    if (!bounds) return copyText(full, "表格 Markdown 已复制");
    // 只复制选中矩形：源码行 0=表头、1=分隔行、2..=数据行；视觉行 r>0 对应源码行 r+1
    const src = full.split("\n").filter((l) => l.trim());
    const pick = (line) => {
      const cells = splitTableRow(line).slice(bounds.c1, bounds.c2 + 1).map((c) => c.raw);
      return "| " + cells.join(" | ") + " |";
    };
    const head = pick(src[0] || "");
    const delim = pick(src[1] || "");
    const body = selRows.filter((r) => r > 0).map((r) => pick(src[r + 1] || "")).filter(Boolean);
    return copyText([head, delim, ...body].join("\n") + "\n", "已复制选中区域");
  };
  const deleteTable = () => {
    const from = Number(wrap.dataset.from);
    const to = Number(wrap.dataset.to);
    view.dispatch({ changes: { from, to, insert: "" }, selection: { anchor: from } });
  };
  // 进源码：先把格子里的编辑提交掉，再把光标落到表格首行，之后就是普通文本编辑
  const editSource = async () => {
    await commitCellEditor();
    if (lineNo < 1 || lineNo > view.state.doc.lines) return;
    const line = view.state.doc.line(lineNo);
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  };
  const formatSource = () =>
    formatTable(view, lineNo).then((ok) => flash(ok ? "表格源码已按列对齐" : "表格源码已经是整齐的"));

  return [
    ...(bounds
      ? [
          { label: `已选中 ${selRows.length} 行 × ${selCols.length} 列`, disabled: true },
          { label: "取消选择", action: () => { clearTableSelection(lineNo); paintTableSelection(wrap, lineNo); } },
          { separator: true },
        ]
      : []),
    { label: "选中整行", action: select({ row, col: 0 }, { row, col: colCount - 1 }) },
    { label: "选中整列", action: select({ row: 0, col }, { row: lastRow, col }) },
    { separator: true },
    {
      label: "插入行",
      children: [
        {
          label: "上方插入行",
          disabled: row <= 0,
          action: act((rows) => {
            if (row <= 0) return false;
            rows.splice(row + 1, 0, Array.from({ length: rows[0].length }, () => ""));
          }),
        },
        { label: "下方插入行", accel: "Ctrl+Enter", action: act((rows) => insertTableRow(rows, row)) },
      ],
    },
    {
      label: "插入列",
      children: [
        {
          label: "左侧插入列",
          action: act((rows) => {
            rows.forEach((r, i) => r.splice(col, 0, i === 1 ? "---" : ""));
          }),
        },
        { label: "右侧插入列", action: act((rows) => insertTableCol(rows, col)) },
      ],
    },
    {
      label: "移动该行",
      children: [
        { label: "上移该行", accel: "Alt+↑", disabled: row <= 1, action: act((rows) => moveTableRow(rows, row, -1)) },
        {
          label: "下移该行",
          accel: "Alt+↓",
          disabled: row <= 0 || row >= lastRow,
          action: act((rows) => moveTableRow(rows, row, 1)),
        },
      ],
    },
    {
      label: "移动该列",
      children: [
        { label: "左移该列", accel: "Alt+←", disabled: col <= 0, action: act((rows) => moveTableCol(rows, col, -1)) },
        {
          label: "右移该列",
          accel: "Alt+→",
          disabled: col >= colCount - 1,
          action: act((rows) => moveTableCol(rows, col, 1)),
        },
      ],
    },
    {
      label: "对齐方式",
      children: [
        { label: "左对齐", action: act((rows) => setAlign(rows, col, "left")) },
        { label: "居中", action: act((rows) => setAlign(rows, col, "center")) },
        { label: "右对齐", action: act((rows) => setAlign(rows, col, "right")) },
      ],
    },
    { separator: true },
    {
      label: "删除行",
      disabled: lastRow <= 0,
      action: act((rows) => {
        if (!manyRows) return deleteTableRow(rows, row);
        // 降序删，前面的行号才不会因为删除而错位
        for (const r of [...selRows].sort((a, b) => b - a)) deleteTableRow(rows, r);
      }),
    },
    {
      label: "删除列",
      disabled: colCount <= 1,
      action: act((rows) => {
        if (!manyCols) return deleteTableCol(rows, col);
        for (const c of [...selCols].sort((a, b) => b - a)) deleteTableCol(rows, c);
      }),
    },
    { label: "删除表格", danger: true, action: deleteTable },
    { separator: true },
    { label: "复制表格", action: copyTable },
    { label: "格式化表格源码", action: formatSource },
    { label: "编辑表格源码", action: editSource },
    {
      label: "排序",
      children: [
        { label: "按当前列升序排列", action: act((rows) => sortTableRows(rows, col, false)) },
        { label: "按当前列降序排列", action: act((rows) => sortTableRows(rows, col, true)) },
      ],
    },
  ];
}

function imageSourceRange(el) {
  let from = Number(el.dataset.from);
  let to = Number(el.dataset.to);
  const doc = view.state.doc;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > doc.length) return null;
  let raw = doc.sliceString(from, to);
  if (!raw.startsWith("![")) {
    const line = doc.lineAt(Math.min(from, doc.length));
    const idx = line.text.indexOf("![");
    if (idx >= 0) {
      from = line.from + idx;
      const m = /^!\[([^\]]*)\]\(([\s\S]*?)\)\s*(\{[^{}]*\})?/.exec(line.text.slice(idx));
      if (m) {
        to = from + m[0].length;
        raw = doc.sliceString(from, to);
      }
    }
  } else {
    const trailing = doc.sliceString(to, Math.min(doc.length, to + 120));
    const braceMatch = /^\{[^{}\n]*\}/.exec(trailing);
    if (braceMatch && !raw.includes("{")) {
      to += braceMatch[0].length;
      raw = doc.sliceString(from, to);
    }
  }
  return { from, to, src: el.dataset.markdownSrc || "", raw };
}

function getImageAttrsFromEl(el) {
  const info = imageSourceRange(el);
  if (!info) return { width: el.dataset.width || "", align: el.dataset.align || "" };
  const attrMatch = /\{([^{}]*)\}\s*$/.exec(info.raw);
  const parsed = attrMatch ? parseImageAttrs(attrMatch[1]) : { width: "", align: "" };
  return {
    width: parsed.width || el.dataset.width || "",
    align: parsed.align || el.dataset.align || "",
  };
}

function updateImageAttributes(el, { width, align }) {
  const info = imageSourceRange(el);
  if (!info || !info.raw.includes("![")) return flash("图片源码位置已变化，请重试");
  const parsed = parseImageMd(info.raw);
  if (!parsed) return flash("无法解析图片语法");

  const currentAttrs = parsed.attrs
    ? parseImageAttrs(parsed.attrs.replace(/^\{|\}$/g, ""))
    : { width: "", align: "" };

  const newWidth = width !== undefined ? width : currentAttrs.width;
  const newAlign = align !== undefined ? align : currentAttrs.align;

  const attrParts = [];
  if (newWidth) attrParts.push(`width=${newWidth}`);
  if (newAlign) attrParts.push(`align=${newAlign}`);
  const attrs = attrParts.length ? `{${attrParts.join(" ")}}` : "";

  const insert = formatImageMd(parsed.alt, parsed.src, parsed.title, attrs);
  if (insert === info.raw) return true;

  view.dispatch({
    changes: { from: info.from, to: info.to, insert },
    selection: { anchor: info.from },
  });
  return true;
}

function updateImageScale(el, width) {
  const ok = updateImageAttributes(el, { width });
  if (ok) flash(width ? `已调整图片尺寸为 ${width}` : "已恢复图片原始尺寸");
}

function updateImageAlign(el, align) {
  const ok = updateImageAttributes(el, { align });
  const names = { "": "默认", left: "靠左", center: "居中", right: "靠右" };
  if (ok) flash(`已调整图片对齐为${names[align] || align}`);
}

async function promptCustomImageScale(el, currentWidth) {
  const result = await askText("编辑图片缩放", currentWidth || "100%", "缩放比例", "例如 50%、80% 或 400px");
  if (result === null) return;
  let val = result.trim();
  if (!val || val === "auto" || val === "0") {
    updateImageScale(el, "");
    return;
  }
  if (/^\d+(\.\d+)?$/.test(val)) {
    val = val + "px";
  }
  if (!/^(\d+(\.\d+)?(%|px|em|rem|vw|vh)?)$/i.test(val)) {
    flash("格式不正确，请输入如 50% 或 400px");
    return;
  }
  updateImageScale(el, val);
}

function editImageSyntax(el) {
  const info = imageSourceRange(el);
  if (!info) return flash("图片源码位置已变化，请重试");
  const anchor = Math.min(info.from + 2, Math.max(info.from, info.to - 1));
  view.dispatch({
    selection: { anchor },
    effects: setEditingImage.of({ from: info.from, to: info.to }),
    scrollIntoView: true,
  });
  view.focus();
}

function removeImageReference(el) {
  const info = imageSourceRange(el);
  if (!info || !info.raw.includes("![")) return flash("图片源码位置已变化，请重试");
  view.dispatch({ changes: { from: info.from, to: info.to, insert: "" }, selection: { anchor: info.from } });
  flash("已删除图片引用，源文件未改动");
}

async function relocateImage(el, move) {
  const info = imageSourceRange(el);
  if (!info || !state.path || !window.studio) return flash("请先保存文档，再整理本地图片");
  const invoke = move ? window.studio.moveImages : window.studio.collectImages;
  const mapped = await invoke([info.src], state.path, currentImageFolder());
  const next = mapped[info.src];
  if (!next) throw new Error("远程图片或失效路径不能整理");
  if (next === info.src) return flash("图片已经在当前目录");
  const at = info.raw.indexOf(info.src);
  if (at < 0) throw new Error("图片源码位置已变化，请重试");
  const raw = info.raw.slice(0, at) + next + info.raw.slice(at + info.src.length);
  view.dispatch({ changes: { from: info.from, to: info.to, insert: raw } });
  flash(move ? "图片已移动并更新引用；原文件已移到回收站" : "图片已复制并更新引用");
}

async function deleteImageAndFile(el) {
  const info = imageSourceRange(el);
  if (!info || !state.path || !window.studio?.trashImage) return flash("只能删除已保存文档中的本地图片");
  const ok = await window.studio.confirm("确定删除图片引用，并把源文件移到回收站吗？");
  if (!ok) return;
  await window.studio.trashImage(info.src, state.path);
  removeImageReference(el);
  flash("图片引用已删除，源文件已移到回收站");
}

function imageContextItems(el) {
  const local = state.path && window.studio;
  const { width: currentWidth, align: currentAlign } = getImageAttrsFromEl(el);

  return [
    {
      label: "缩放图片",
      children: [
        { label: "25%", checked: currentWidth === "25%", action: () => updateImageScale(el, "25%") },
        { label: "50%", checked: currentWidth === "50%", action: () => updateImageScale(el, "50%") },
        { label: "75%", checked: currentWidth === "75%", action: () => updateImageScale(el, "75%") },
        { label: "100%", checked: currentWidth === "100%", action: () => updateImageScale(el, "100%") },
        { separator: true },
        {
          label: currentWidth && !["25%", "50%", "75%", "100%"].includes(currentWidth)
            ? `自定义缩放 (${currentWidth})...`
            : "自定义缩放...",
          action: () => promptCustomImageScale(el, currentWidth),
        },
        { label: "重置大小", checked: !currentWidth, action: () => updateImageScale(el, "") },
      ],
    },
    { label: "编辑缩放...", action: () => promptCustomImageScale(el, currentWidth) },
    {
      label: "对齐方式",
      children: [
        { label: "默认", checked: !currentAlign, action: () => updateImageAlign(el, "") },
        { label: "居中", checked: currentAlign === "center", action: () => updateImageAlign(el, "center") },
        { label: "靠左", checked: currentAlign === "left", action: () => updateImageAlign(el, "left") },
        { label: "靠右", checked: currentAlign === "right", action: () => updateImageAlign(el, "right") },
      ],
    },
    { label: "编辑图片语法", action: () => editImageSyntax(el) },
    { separator: true },
    { label: "复制图片地址", action: () => copyText(el.dataset.markdownSrc || "", "图片地址已复制") },
    { label: "复制图片到配置目录", disabled: !local, action: () => relocateImage(el, false) },
    { label: "移动图片到配置目录", disabled: !local, action: () => relocateImage(el, true) },
    { label: "上传图片到图床", disabled: !local, action: () => uploadImageFromMenu(el) },
    { separator: true },
    { label: "仅删除图片引用", action: () => removeImageReference(el) },
    { label: "删除图片及源文件", danger: true, disabled: !local, action: () => deleteImageAndFile(el) },
  ];
}

/**
 * 正文右键菜单：照 Typora 的段落面板排——图标行 + 多列按钮网格 + 分组的二级菜单，
 * 而不是二十多项排成一长条。命令都走 commands 表，和快捷键、菜单栏保持同一套行为。
 */
function baseEditorContextItems() {
  const empty = view.state.selection.main.empty;
  return [
    {
      grid: [
        { icon: "cut", title: "剪切", disabled: empty, action: () => run("cut") },
        { icon: "copy", title: "复制", disabled: empty, action: () => run("copy") },
        { icon: "paste", title: "粘贴", action: () => run("paste") },
        {
          icon: "trash",
          title: "删除所选",
          disabled: empty,
          action: () => view.dispatch(view.state.replaceSelection("")),
        },
      ],
    },
    {
      label: "复制 / 粘贴为…",
      children: [
        { label: "复制为 Markdown", disabled: empty, action: () => run("copy-markdown") },
        { label: "粘贴为纯文本", action: () => run("paste-plain") },
        { label: "全选", accel: ACCEL["select-all"], action: () => run("select-all") },
      ],
    },
    {
      grid: [
        { label: "B", title: "加粗", cls: "is-bold", action: () => run("bold") },
        { label: "I", title: "斜体", cls: "is-italic", action: () => run("italic") },
        { icon: "code", title: "行内代码", action: () => run("code") },
        { icon: "link", title: "插入链接", action: () => run("link") },
      ],
    },
    {
      grid: [
        { label: "❝", title: "引用", action: () => run("quote") },
        { label: "1.", title: "有序列表", action: () => run("ol") },
        { label: "•", title: "无序列表", action: () => run("ul") },
        { label: "☑", title: "任务列表", action: () => run("task") },
      ],
    },
    {
      label: "段落",
      children: [
        { label: "正文", action: () => run("p") },
        { label: "一级标题", accel: "Ctrl+1", action: () => run("h1") },
        { label: "二级标题", accel: "Ctrl+2", action: () => run("h2") },
        { label: "三级标题", accel: "Ctrl+3", action: () => run("h3") },
        { label: "四级标题", action: () => run("h4") },
        { label: "五级标题", action: () => run("h5") },
        { label: "六级标题", action: () => run("h6") },
        { separator: true },
        { label: "清除格式", disabled: empty, action: () => run("clear-format") },
      ],
    },
    {
      label: "插入",
      children: [
        { label: "图像", action: () => run("image") },
        { label: "表格…", accel: ACCEL.table, action: () => run("table") },
        { label: "代码块", action: () => run("fence") },
        { label: "公式块", action: () => run("math") },
        { label: "水平分割线", action: () => run("hr") },
        { label: "内容目录", action: () => run("toc") },
      ],
    },
  ];
}

function openLink(href) {
  let url = String(href || "").trim();
  if (!url) return false;
  // GFM autolink 的 www.example.com 没有协议，补成 https 再交给系统浏览器。
  if (/^www\./i.test(url)) url = "https://" + url;
  if (url.startsWith("#")) {
    let slug = url.slice(1);
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* 非法的 % 序列就按原样比 */
    }
    const pos = headingPosBySlug(slug);
    if (pos < 0) return false;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    view.contentDOM.focus({ preventScroll: true });
    return true;
  }
  if (/^(https?:|mailto:)/i.test(url)) {
    // 失败要可见：以前这里把错误吞掉，用户只会觉得「点了没反应」。
    window.studio
      ?.openExternal(url)
      ?.catch((e) => flash("无法打开链接：" + (e?.message || e)));
    return true;
  }
  flash("编辑器不打开相对路径：" + url);
  return false;
}

// 编辑区上下文菜单：按图片、表格、链接和普通文本分别给出可用操作。
view.dom.addEventListener("contextmenu", (e) => {
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest(".cm-cell-editor, .cm-image-url")) return;
  const image = target.closest(".cm-image");
  if (image && view.dom.contains(image)) {
    showContextMenu(e, imageContextItems(image));
    return;
  }
  const cell = target.closest("td, th");
  const table = target.closest(".cm-table-wrap");
  if (cell && table && view.dom.contains(table)) {
    showContextMenu(e, tableContextItems(table, cell));
    return;
  }
  const link = target.closest(".cm-link");
  if (link && view.dom.contains(link)) {
    const href = link.dataset.href || "";
    showContextMenu(e, [
      { label: "打开链接", action: () => openLink(href) },
      { label: "复制链接地址", action: () => copyText(href, "链接地址已复制") },
      { separator: true },
      ...baseEditorContextItems(),
    ]);
    return;
  }
  // 无选区（或右键落在选区之外）时，先将光标移到点击位置再弹菜单
  const clickPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (clickPos != null) {
    const main = view.state.selection.main;
    const insideSel = !main.empty && clickPos >= main.from && clickPos <= main.to;
    if (!insideSel) {
      view.dispatch({ selection: { anchor: clickPos } });
    }
  }
  showContextMenu(e, baseEditorContextItems());
});

// 点击位置对应的链接地址。活动行会把链接展开成 [文字](地址) 源码，
// 这时 DOM 上没有 .cm-link，就按语法树把地址找出来。
function linkHrefAt(pos) {
  const doc = view.state.doc;
  for (let n = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "Image") return ""; // 图片地址不当网页打开
    if (n.name === "URL") return doc.sliceString(n.from, n.to);
    if (n.name === "Link" || n.name === "Autolink") {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.name === "URL") return doc.sliceString(c.from, c.to);
      }
      if (n.name === "Autolink") {
        return doc.sliceString(n.from, n.to).replace(/^<|>$/g, "");
      }
    }
  }
  return "";
}

// Ctrl / Cmd + 点击正文里的链接。按住修饰键时才拦截，
// 否则连「点一下把光标放进去」都没法做。
view.contentDOM.addEventListener("mousedown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
  const el = e.target instanceof Element ? e.target.closest(".cm-link") : null;
  if (el) {
    e.preventDefault();
    e.stopPropagation();
    openLink(el.dataset.href || "");
    return;
  }
  // 链接所在行正在编辑（显示源码）时也能 Ctrl+点击打开
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return;
  const href = linkHrefAt(pos);
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  openLink(href);
});

// 点到正文最后一行下面的空白，光标落到最后一行，不必刚好点在那一行上。
view.dom.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (
    target.closest(
      ".cm-lang-badge, .cm-fence-copy, .cm-fence-chip, button, a, input, textarea",
    )
  )
    return;
  const last = view.contentDOM.lastElementChild;
  if (!last) return;
  const sc = view.scrollDOM.getBoundingClientRect();
  if (
    e.clientX < sc.left ||
    e.clientX > sc.right ||
    e.clientY < sc.top ||
    e.clientY > sc.bottom
  )
    return;
  if (e.clientY <= last.getBoundingClientRect().bottom) return;
  e.preventDefault();
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.focus();
});

function insertAtCursor(text, selectOffset) {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + (selectOffset ?? text.length) },
    scrollIntoView: true,
  });
  view.focus();
}

/** 光标是否落在围栏/缩进代码块里——代码块里的 `- ` `> ` 是内容，不是标记 */
function inCodeBlock(state, pos) {
  for (let n = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

/** 列表行的续行前缀（有序 +1、任务补 [ ]）；不是列表项返回 null */
function nextListPrefix(lineText) {
  const m = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/.exec(lineText);
  if (!m) return null;
  let mark = m[2];
  if (/^\d/.test(mark)) mark = String(parseInt(mark, 10) + 1) + mark.slice(-1);
  return { m, prefix: m[1] + mark + " " + (m[4] ? "[ ] " : "") };
}

/**
 * 回车延续列表（Typora 的默认行为）：
 * - 有序列表序号自动 +1，任务列表补回未勾选的 `- [ ] `
 * - 在空的列表项上回车 = 退出列表（把这一行的标记清掉）
 * - 光标还在标记里面、或这一行根本不是列表：返回 false，交回 defaultKeymap
 */
function continueList(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.from);
  if (inCodeBlock(state, sel.from)) return false;
  const next = nextListPrefix(line.text);
  if (!next) return false;
  const { m, prefix } = next;
  if (sel.from < line.from + m[0].length) return false;

  // 「空列表项」要看标记之后的正文，不是光标之后的文字——
  // 拿光标位置切字符串的话，人在行尾敲回车时永远是「空」，整行标记会被当场剥掉。
  if (!line.text.slice(m[0].length).trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.from + m[0].length, insert: "" },
      selection: { anchor: line.from },
    });
    return true;
  }

  const insert = "\n" + prefix;
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
  });
  return true;
}

/**
 * 引用块里回车续 `>`（Typora 行为）。
 * `> - x` 这种「引用里套列表」也认：续行时把列表标记一并补上，
 * 否则在引用里列个清单，每敲一次回车都得先手打 `>` 再打 `- `。
 * 空的引用行上回车 = 退出引用。
 */
function continueQuote(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.from);
  if (inCodeBlock(state, sel.from)) return false;
  const m = /^([ \t]*(?:>[ \t]?)+)([\s\S]*)$/.exec(line.text);
  if (!m) return false;
  if (sel.from < line.from + m[1].length) return false;

  if (!m[2].trim()) {
    view.dispatch({
      changes: { from: line.from, to: line.from + m[1].length, insert: "" },
      selection: { anchor: line.from },
    });
    return true;
  }

  const inner = nextListPrefix(m[2]);
  const insert = "\n" + m[1] + (inner ? inner.prefix : "");
  view.dispatch({
    changes: { from: sel.from, insert },
    selection: { anchor: sel.from + insert.length },
  });
  return true;
}

/**
 * 引用后面如果没有空行，下一行文字在语法上仍算这段引用，画面上却不带 `>`。
 * 这时回车若交给 markdown 自带的续行，会凭空补出一个 `>`。
 * 这里改成普通换行，引用到此为止。
 */
function newlineAfterLazyQuote(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.from);
  if (inCodeBlock(state, sel.from)) return false;
  if (/^[ \t]*>/.test(line.text)) return false;
  let inQuote = false;
  for (let n = syntaxTree(state).resolveInner(sel.from, -1); n; n = n.parent) {
    if (n.name === "Blockquote") {
      inQuote = true;
      break;
    }
  }
  if (!inQuote) return false;
  view.dispatch({
    changes: { from: sel.from, insert: "\n" },
    selection: { anchor: sel.from + 1 },
  });
  return true;
}

/**
 * Tab / Shift+Tab 调列表层级（Typora 的手感：Tab 降一级，Shift+Tab 回来）。
 * 只对列表行生效 —— 正文里的 Tab、代码块里的缩进仍然交给 indentWithTab。
 * 一次缩进 2 空格，和回车续标记、无序列表「按 2 空格算一层」共用一个标尺，
 * 不然圆的圆点层级会跳。
 */
function indentList(view, dir) {
  const { state } = view;
  const listRe = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
  const lineNos = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) if (!lineNos.includes(n)) lineNos.push(n);
  }

  const changes = [];
  for (const n of lineNos) {
    const line = state.doc.line(n);
    if (!listRe.test(line.text)) continue;
    if (inCodeBlock(state, line.from)) continue;
    if (dir > 0) {
      changes.push({ from: line.from, insert: "  " });
    } else {
      const lead = /^[ \t]*/.exec(line.text)[0];
      const cut = Math.min(2, lead.length);
      if (cut) changes.push({ from: line.from, to: line.from + cut });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes });
  return true;
}

function insertFence() {
  const sel = view.state.sliceDoc(
    view.state.selection.main.from,
    view.state.selection.main.to,
  );
  const body = sel || "// 代码";
  insertAtCursor("```js\n" + body + "\n```\n", body.length + 6);
}

function insertMathBlock() {
  insertAtCursor("$$\n\\int_{0}^{1} x^2\\,dx = \\frac{1}{3}\n$$\n", 3);
}

/** 插入表格时选择器的弹出位置：贴着光标下方；拿不到坐标就退到窗口中心。 */
function insertAnchorAtCaret() {
  try {
    const c = view.coordsAtPos(view.state.selection.main.from);
    if (c && Number.isFinite(c.left) && Number.isFinite(c.bottom)) {
      return { x: c.left, y: c.bottom };
    }
  } catch {
    /* 文档还没布局好时 coordsAtPos 会拿不到坐标 */
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** 记住上次选的尺寸：连续插几张表时不用每次重新拨。 */
let lastTableSize = { cols: 3, rows: 2 };

/** 打开「几行几列」选择器；尺寸确认后按光标位置插入。 */
function pickTableSize() {
  openTablePicker({
    anchor: insertAnchorAtCaret(),
    initial: lastTableSize,
    onPick: ({ cols, rows }) => {
      lastTableSize = { cols, rows };
      insertTable(cols, rows);
    },
    onClose: () => view.focus(),
  });
}

/**
 * 插入 cols × rows（含表头）的空表格。表格是块级结构，光标若落在正文
 * 中间，前后各补换行把段落切开，避免源码和表格粘在同一行；
 * 插完把光标放进第一个表头格，直接打字即可填写。
 */
function insertTable(cols = 3, rows = 2) {
  const md = buildTableMarkdown(cols, rows);
  const { state } = view;
  const range = state.selection.main;
  const startLine = state.doc.lineAt(range.from);
  const endLine = state.doc.lineAt(range.to);
  const prefix = startLine.text.slice(0, range.from - startLine.from).trim() ? "\n\n" : "";
  const suffix = endLine.text.slice(range.to - endLine.from).trim() ? "\n" : "";
  const from = range.from;
  view.dispatch({
    changes: { from, to: range.to, insert: prefix + md + suffix },
    // 「| 」之后就是第一个空表头格
    selection: { anchor: from + prefix.length + 2 },
    scrollIntoView: true,
  });
  view.focus();
}

function insertHr() {
  insertAtCursor("\n\n---\n\n");
}

// [toc] 必须独占一行才会被渲染成目录，所以前后都补空行
function insertToc() {
  insertAtCursor("\n\n[toc]\n\n");
}

/**
 * 列表 / 引用的行前缀开关：选中的行全都有这个前缀就去掉，否则统一加上。
 * 「全都有才去掉」比「逐行取反」更接近菜单里的心理预期（一般是想整段加上或整体取消）。
 */
function toggleLinePrefix(prefixFn) {
  const { state: s } = view;
  const lines = new Set();
  for (const r of s.selection.ranges) {
    const a = s.doc.lineAt(r.from).number;
    const b = s.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  const nos = [...lines].sort((x, y) => x - y);
  const infos = nos.map((n) => {
    const line = s.doc.line(n);
    const m = prefixFn.match(line.text);
    return { line, m };
  });
  const allHave = infos.every((i) => i.m);
  const changes = [];
  for (const { line, m } of infos) {
    if (allHave)
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: "",
      });
    else if (!m) changes.push({ from: line.from, insert: prefixFn.insert });
  }
  if (!changes.length) return;
  const changeSet = s.changes(changes);
  const selection = EditorSelection.create(
    s.selection.ranges.map((r) =>
      EditorSelection.range(
        changeSet.mapPos(r.anchor, 1),
        changeSet.mapPos(r.head, 1),
      ),
    ),
    s.selection.mainIndex,
  );
  view.dispatch({ changes: changeSet, selection, scrollIntoView: true });
  view.focus();
}

const quotePrefix = {
  insert: "> ",
  match: (text) => /^\s{0,3}>\s?/.exec(text),
};

const ulPrefix = {
  insert: "- ",
  match: (text) => /^\s*[-*+]\s+\[[ xX]\]\s+|^\s*[-*+]\s+/.exec(text),
};

const olPrefix = {
  insert: "1. ",
  match: (text) => /^\s*\d+[.)]\s+/.exec(text),
};

const taskPrefix = {
  insert: "- [ ] ",
  match: (text) => /^\s*[-*+]\s+\[[ xX]\]\s+/.exec(text),
};

/* ---------------- 图片 ---------------- */

function currentImageFolder() {
  try {
    const parts = String(localStorage.getItem(IMAGE_FOLDER_KEY) || "assets")
      .split(/[\\/]+/)
      .filter((part) => part && part !== "." && part !== ".." && /^[\w\-\u4e00-\u9fa5]+$/.test(part));
    return parts.slice(0, 4).join("/") || "assets";
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

/* ---------------- 文件 ---------------- */

function browserDownload(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function openFile() {
  if (window.studio) {
    const r = await window.studio.openDialog();
    if (!r || !(await settleCurrentDocument())) return;
    openDiskDoc(r);
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,.markdown,.txt";
    input.onchange = async () => {
      const f = input.files[0];
      if (!f || !(await settleCurrentDocument())) return;
      loadDoc(await f.text(), f.name);
    };
    input.click();
  }
}

const documentTabs = [];
const tabsEnabled = !new URLSearchParams(location.search).has("selftest");

/* 会话持久化：只存路径等元数据（EditorState 不进存储），重启后恢复标签列表。 */

function persistSession() {
  if (!tabsEnabled || !window.studio) return;
  try {
    const tabs = documentTabs.map((t) => t.path).filter(Boolean);
    if (!tabs.length && !state.path) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ tabs, active: state.path, updatedAt: Date.now() }),
    );
  } catch {
    /* 存储不可用时退化为不恢复会话 */
  }
}

async function restoreSession() {
  let session = null;
  try {
    session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return;
  }
  if (!session || !Array.isArray(session.tabs)) return;
  const paths = session.tabs.filter((p) => typeof p === "string" && p);
  const active = typeof session.active === "string" ? session.active : null;
  // 非活动标签只登记元数据，点开时才读盘，避免启动时把所有文件都读一遍。
  for (const p of paths) {
    if (!documentTabs.some((t) => samePath(t.path, p))) {
      documentTabs.push({ path: p, editorState: null });
    }
  }
  if (active && paths.some((p) => samePath(p, active))) {
    try {
      const r = await window.studio.readFile(active);
      openDiskDoc(r);
      return;
    } catch {
      /* 活动文件已不存在：保留其余标签，正文留空 */
    }
  }
  syncTabs();
}

function remapDocumentTabs(source, dest) {
  for (const tab of documentTabs) {
    const norm = (p) => String(p).toLowerCase();
    if (samePath(tab.path, source)) tab.path = dest;
    else if (norm(tab.path).startsWith(norm(source) + "\\") || norm(tab.path).startsWith(norm(source) + "/")) {
      tab.path = dest + tab.path.slice(source.length);
    }
  }
}

function removeDocumentTabsUnder(source) {
  const norm = (p) => String(p).toLowerCase();
  for (let i = documentTabs.length - 1; i >= 0; i--) {
    const p = norm(documentTabs[i].path);
    if (samePath(documentTabs[i].path, source) || p.startsWith(norm(source) + "\\") || p.startsWith(norm(source) + "/")) {
      documentTabs.splice(i, 1);
    }
  }
}

function syncTabs() {
  // EditorState 留在运行时自己手里，Pinia 只放元数据（响应式系统不能包 CM 状态）。
  shell.syncTabs(
    documentTabs.map((tab) => ({ path: tab.path, active: samePath(tab.path, state.path) })),
  );
  persistSession();
}

async function openTab(path) {
  if (samePath(path, state.path) || !(await settleCurrentDocument())) return;
  try {
    const r = await window.studio.readFile(path);
    openDiskDoc(r);
  } catch (err) {
    flash("打开标签失败：" + (err?.message || err));
  }
}

async function closeTab(path) {
  const tab = documentTabs.find((item) => samePath(item.path, path));
  if (!tab) return;
  const active = samePath(tab.path, state.path);
  if (active && !(await settleCurrentDocument())) return;
  const index = documentTabs.indexOf(tab);
  documentTabs.splice(index, 1);
  if (active) {
    const next = documentTabs[Math.max(0, index - 1)];
    if (next) {
      try {
        const r = await window.studio.readFile(next.path);
        openDiskDoc(r);
        return;
      } catch {
        /* 文件已被外部删除时退回空白文档 */
      }
    }
    loadDoc("", null);
  } else syncTabs();
}

function snapshotDocumentTab(oldPath = state.path) {
  if (!tabsEnabled || !oldPath) return;
  let tab = documentTabs.find((item) => samePath(item.path, oldPath));
  if (!tab) {
    tab = { path: oldPath, editorState: null };
    documentTabs.push(tab);
  }
  if (samePath(oldPath, state.path)) tab.editorState = view.state;
}

function loadDoc(content, pathOrName, { keepHistory = false } = {}) {
  // UTF-8 BOM 是编码签名，不应参与 Markdown 解析；否则首个标题和 YAML 文首信息会失效。
  Object.assign(state, detectDocFormat(content));
  // 编码标记随载入重置；从磁盘打开时由 openDiskDoc 按读取结果回填。
  state.encoding = "utf-8";
  const text = withTrailingBlank(normalizeMarkdownText(content));
  const oldPath = state.path;
  if (!keepHistory) snapshotDocumentTab(oldPath);
  const isFullPath = !!pathOrName && /[\\/]/.test(pathOrName);
  const previousTab = !keepHistory && isFullPath
    ? documentTabs.find((item) => samePath(item.path, pathOrName) && item.editorState?.doc.toString() === text)
    : null;
  // 换文档前先把表格浮层收掉，否则它挂着的源码区间会指到新文档上
  cancelCellEditor();
  state.path = isFullPath ? pathOrName : null;
  state.dir = isFullPath ? pathOrName.replace(/[\\/][^\\/]*$/, "") : null;
  window.studio?.watchDocument?.(state.path);
  if (isFullPath) rememberRecent(pathOrName);
  forgetMissingPastes(text);
  // 基址必须赶在灌内容之前设好：dispatch 会同步构建第一屏的 widget。
  // Tauri 下本地图片走 asset protocol（见 platform/studio.js 的 docBaseUrl）。
  if (window.studio && isFullPath) {
    setDocBase(docBaseUrl(state.dir));
  } else {
    setDocBase(null);
  }
  // 撤销栈挂在编辑器上。换文件若只做整篇替换，这一步会留在栈里，
  // Ctrl+Z 会把上一份文件的正文撤进当前文件。
  // 另存为是同一篇文稿，只换路径，栈要留着。
  if (previousTab) {
    view.setState(previousTab.editorState);
  } else if (keepHistory) {
    if (text !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    }
    view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
  } else {
    // 先卸掉历史再换正文。addToHistory:false 会把旧记录映射过来，
    // 必须等栈已经空了再换。
    view.dispatch({ effects: historySlot.reconfigure([]) });
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: 0 },
      scrollIntoView: true,
      effects: historySlot.reconfigure(history()),
      annotations: Transaction.addToHistory.of(false),
    });
  }
  setDirty(false);
  if (tabsEnabled && isFullPath) {
    if (keepHistory && oldPath && !samePath(oldPath, pathOrName)) {
      const oldIndex = documentTabs.findIndex((item) => samePath(item.path, oldPath));
      if (oldIndex >= 0) documentTabs.splice(oldIndex, 1);
    }
    snapshotDocumentTab(pathOrName);
  }
  syncTabs();
  updateStatus("");
  renderOutline();
  if (sidebarVisible() && sideView() === "files") shell.bumpFileTree();
}

/** 从磁盘打开的统一入口：载入正文并回填读取时判定的编码，保存时按原编码写回。 */
function openDiskDoc(r) {
  loadDoc(r.content, r.path);
  state.encoding = String(r.encoding || "utf-8").toLowerCase();
  if (state.encoding !== "utf-8") {
    flash(`已按 ${state.encoding.toUpperCase()} 编码打开，保存时保持原编码`);
  }
}

async function save() {
  let content = view.state.doc.toString();
  if (!window.studio) {
    const name = state.path || "未命名.md";
    browserDownload(name, serializeForDisk(content, state), "text/markdown");
    setDirty(false);
    return true;
  }
  if (state.path) {
    const targetPath = state.path;
    content = await settlePastedImages(content, targetPath);
    if (content !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
      forgetMissingPastes(content);
    }
    try {
      await window.studio.saveFile(targetPath, serializeForDisk(content, state), state.encoding);
    } catch (err) {
      shell.setSaveError(String(err?.message || err));
      throw err;
    }
    // 保存期间用户可能又输入了内容；旧快照落盘成功不能把新编辑标成干净。
    if (state.path === targetPath && view.state.doc.toString() === content) {
      setDirty(false);
      flash("已保存 " + targetPath.split(/[\\/]/).pop());
    } else {
      setDirty(true);
      scheduleAutosave();
      flash("已保存旧快照，较新的修改仍待保存");
    }
    return true;
  }
  return saveAs();
}

async function saveAs() {
  const content = view.state.doc.toString();
  if (!window.studio) {
    browserDownload("未命名.md", serializeForDisk(content, state), "text/markdown");
    setDirty(false);
    return true;
  }
  const p = await window.studio.saveAsDialog(serializeForDisk(content, state), state.path || undefined);
  if (!p) return false;
  const settled = await settlePastedImages(content, p);
  if (settled !== content) await window.studio.saveFile(p, serializeForDisk(settled, state), "utf-8");
  // 另存为是同一篇文稿：loadDoc 会按传入的 LF 正文重测格式，这里还原原有换行风格。
  const { eol, bom } = state;
  loadDoc(settled, p, { keepHistory: true });
  state.eol = eol;
  state.bom = bom;
  flash("已另存为 " + p.split(/[\\/]/).pop());
  return true;
}

async function newDoc() {
  if (!(await settleCurrentDocument())) return;
  loadDoc("", null);
  state.path = null;
  setDirty(false);
  view.focus();
}

function scheduleAutosave() {
  if (!state.autosave || !state.path || !window.studio) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    // 定时器可能在「打开文档 / 手动保存」之后才到点，那时候已经没什么可存的了。
    // 不挡这一下，光是打开一篇文件就会把它重写一遍。
    if (!state.dirty || !state.path) return;
    const targetPath = state.path;
    const content = view.state.doc.toString();
    try {
      await window.studio.saveFile(targetPath, serializeForDisk(content, state), state.encoding);
      if (state.path === targetPath && view.state.doc.toString() === content) {
        setDirty(false);
        flash("已自动保存");
      } else {
        // 新输入已经在保存期间发生，保留脏标记和草稿，并安排下一轮自动保存。
        setDirty(true);
        scheduleAutosave();
      }
    } catch (e) {
      writeDraft();
      shell.setSaveError(String(e?.message || e));
      flash("自动保存失败，草稿已保留");
    }
  }, 1200);
}

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

const quickOpen = createQuickOpen({
  state,
  openSheet,
  flash,
  openFile,
  settleCurrentDocument,
  openDiskDoc,
  samePath,
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

/* ---------------- 最近打开 / 设置 / 许可 ---------------- */

function readRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(p) {
  const list = [p, ...readRecent().filter((item) => !samePath(item, p))].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式写不进去就只在这一次会话里记住 */
  }
}

async function openRecent(p) {
  if (!p || !window.studio?.readFile || !(await settleCurrentDocument())) return;
  try {
    const r = await window.studio.readFile(p);
    openDiskDoc(r);
  } catch {
    const list = readRecent().filter((item) => !samePath(item, p));
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* 同上 */
    }
    flash("打不开这个文件，已从最近列表移除");
  }
}

function applySpellcheck() {
  const on = !!getAppearance().spellcheck;
  if (view?.contentDOM) view.contentDOM.spellcheck = on;
  window.studio?.setSpellcheck?.(on);
}

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
  openSheet("许可", `<pre class="license-copy">${LICENSE_TEXT.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]))}</pre>`);
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
    "主题商店",
    `<div class="theme-grid">${cards}</div>
     <button type="button" id="back-settings" class="settings-btn">返回设置</button>
     <button type="button" id="theme-folder" class="settings-btn">打开主题文件夹</button>
     <p class="settings-note">这里的主题都已经装在程序里。主题文件夹中的「主题名.user.css」会盖在对应主题上面，用来细调颜色和字体。</p>`,
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
      field(t("settings.imageFolder"), `<input data-k="imageFolder" type="text" value="${currentImageFolder().replace(/"/g, "&quot;")}" placeholder="${t("settings.imageFolderPh")}">`) +
      `<p class="settings-note">${t("settings.imageNote")}</p>` +
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
        localStorage.setItem(IMAGE_FOLDER_KEY, el.value.trim() || "assets");
      } catch {
        /* 记住目录是增强项，存储不可用时不影响插图 */
      }
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
      if (key === "fontFamily") patch.fontStyle = "custom";
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
    host.innerHTML = `<p class="settings-note">读词典失败：${err && err.message ? err.message : err}</p>`;
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

const commands = {
  new: newDoc,
  open: openFile,
  "quick-open": quickOpen,
  save,
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
  link: insertLink,
  image: pickImage,
  "upload-document-images": uploadDocumentImages,
  "image-settings": openImageSettings,
  table: pickTableSize,
  toc: insertToc,
  fence: insertFence,
  math: insertMathBlock,
  hr: insertHr,
  quote: () => toggleLinePrefix(quotePrefix),
  ul: () => toggleLinePrefix(ulPrefix),
  ol: () => toggleLinePrefix(olPrefix),
  task: () => toggleLinePrefix(taskPrefix),
  "clear-format": clearFormat,
  undo: () => undo(view),
  redo: () => redo(view),
  "select-all": () => {
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  },
  find: () => {
    openSearchPanel(view);
    view.focus();
  },
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
    document.body.classList.toggle("source-mode", on);
    shell.setSourceMode(on);
    flash(on ? "源代码模式：开" : "源代码模式：关");
    view.focus();
  },
  focus: () => {
    const on = document.body.classList.toggle("focus-mode");
    view.dispatch({ effects: refreshDecorations.of(null) });
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
  "copy-markdown": () => copyMarkdownSelection(),
  cut: () => copySelection(true),
  paste: async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!handlePastedText(text)) insertAtCursor(text);
    } catch {
      flash("无法读取剪贴板");
    }
  },
  "paste-plain": async () => {
    try {
      const text = await navigator.clipboard.readText();
      insertAtCursor(text);
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
async function copySelection(cut) {
  const { state: s } = view;
  if (s.selection.main.empty) {
    flash("没有选中内容");
    return;
  }
  const { html, plain } = renderSelectionForClipboard(s, state.dir);
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
    view.dispatch(
      s.changeByRange((r) => ({
        changes: { from: r.from, to: r.to, insert: "" },
        range: EditorSelection.cursor(r.from),
      })),
    );
  }
  view.focus();
}

/**
 * 复制为 Markdown 源码（Ctrl+Shift+C）。
 */
async function copyMarkdownSelection(v) {
  const targetView = v || view;
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

/** 去掉选中文本的行内标记（**、*、~~、`、[text](url) → text） */
function clearFormat() {
  const { state: s } = view;
  view.dispatch(
    s.changeByRange((range) => {
      const raw = s.sliceDoc(range.from, range.to);
      const plain = raw
        .replace(/==(.+?)==/g, "$1")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/~~(.+?)~~/g, "$1")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      return {
        changes: { from: range.from, to: range.to, insert: plain },
        range: EditorSelection.range(range.from, range.from + plain.length),
      };
    }),
  );
  view.focus();
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
let handlingExternalChange = false;

/** 外部修改冲突的三态询问：保留我的编辑 / 载入磁盘版本 / 取消（继续编辑，稍后再说）。 */
function askExternalConflict() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    openSheet(
      "文件已在其他程序中修改",
      (body, close) => {
        const text = document.createElement("p");
        text.className = "settings-note";
        text.textContent = "磁盘上的内容与当前编辑不一致，如何处理？";
        const hint = document.createElement("p");
        hint.className = "settings-note";
        hint.textContent =
          "「保留我的编辑」继续当前内容，保存时会覆盖磁盘版本；" +
          "「载入磁盘版本」放弃当前未保存的修改；「取消」暂不处理，继续编辑。";
        const row = document.createElement("div");
        row.className = "ask-actions";
        const main = document.createElement("div");
        main.className = "ask-group";
        const side = document.createElement("div");
        side.className = "ask-group";
        for (const [label, value, kind, group] of [
          ["保留我的编辑", "keep", "primary", main],
          ["载入磁盘版本", "load", "danger", main],
          ["取消", "cancel", "ghost", side],
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

/** 原地载入磁盘版本：保留光标位置（按偏移钳制），不清空撤销栈，可 Ctrl+Z 找回。 */
function reloadFromDisk(content, encoding) {
  Object.assign(state, detectDocFormat(content));
  state.encoding = String(encoding || "utf-8").toLowerCase();
  const text = withTrailingBlank(normalizeMarkdownText(content));
  const sel = view.state.selection.main;
  cancelCellEditor();
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: {
      anchor: Math.min(sel.anchor, text.length),
      head: Math.min(sel.head, text.length),
    },
    scrollIntoView: true,
  });
  forgetMissingPastes(text);
  setDirty(false);
  snapshotDocumentTab(state.path);
  updateStatus("");
  renderOutline();
}

window.studio?.onExternalChange?.(async (file) => {
  if (handlingExternalChange || !samePath(file, state.path)) return;
  handlingExternalChange = true;
  try {
    const r = await window.studio.readFile(file);
    if (withTrailingBlank(normalizeMarkdownText(r.content)) === view.state.doc.toString()) return;
    if (state.dirty) {
      const choice = await askExternalConflict();
      if (choice === "keep") {
        setDirty(true);
        flash("已保留当前编辑，保存时将覆盖磁盘版本");
        return;
      }
      if (choice !== "load") return; // 取消：不动当前内容，继续编辑
    }
    reloadFromDisk(r.content, r.encoding);
    flash("已载入磁盘上的最新版本");
  } catch (err) {
    flash("无法读取外部修改：" + (err?.message || err));
  } finally {
    handlingExternalChange = false;
  }
});

/* ---------------- 菜单栏 ---------------- */

const isSourceMode = () => !!view.state.field(sourceModeField, false);

/**
 * 主题菜单页：把主题 / 密度 / 版心 / 字号 / 字体收进下拉框，
 * 不再把每个选项平铺成一列命令。所有改动仍走原来的 run(cmd) 命令，
 * 选择后面板保持打开，方便连续调整；按钮类命令先关面板再执行。
 */
function renderThemeMenuPage(host, { run, close }) {
  const prefs = getAppearance();
  const form = document.createElement("div");
  form.className = "menu-form";

  const selectRow = (label, options, current, onPick) => {
    const row = document.createElement("label");
    row.className = "menu-form-row";
    const text = document.createElement("span");
    text.textContent = label;
    const select = document.createElement("select");
    for (const [value, name] of options) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = name;
      if (String(value) === String(current)) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onPick(select.value));
    row.append(text, select);
    form.appendChild(row);
  };

  const checkRow = (label, checked, onToggle) => {
    const row = document.createElement("label");
    row.className = "menu-form-row";
    const text = document.createElement("span");
    text.textContent = label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", onToggle);
    row.append(text, input);
    form.appendChild(row);
  };

  selectRow("主题", THEMES.map((t) => [t.id, t.label]), prefs.theme, (v) => run(`theme:${v}`));
  selectRow(
    "密度",
    [["compact", "紧凑"], ["comfortable", "舒适"], ["loose", "疏朗"]],
    prefs.density,
    (v) => run(`appearance:density:${v}`),
  );
  const widths = [["narrow", "窄版心"], ["standard", "标准版心"], ["wide", "宽版心"], ["full", "全宽"]];
  // 设置面板里拖过版心宽度时是 custom，补一个当前项，避免下拉显示成别的值
  if (!widths.some(([v]) => v === prefs.pageWidth)) widths.push([prefs.pageWidth, "自定义宽度"]);
  selectRow("版心", widths, prefs.pageWidth, (v) => run(`appearance:width:${v}`));
  selectRow(
    "正文字号",
    Array.from({ length: 17 }, (_, i) => { const n = 12 + i; return [n, `${n} px`]; }),
    prefs.fontSize,
    (v) => run(`appearance:size:${v}`),
  );
  const fonts = [["theme", "跟随主题字体"], ["sans", "无衬线"], ["serif", "衬线"]];
  if (prefs.fontStyle === "custom") fonts.push(["custom", "自定义字体"]);
  selectRow("字体", fonts, prefs.fontStyle, (v) => run(`appearance:font:${v}`));
  checkRow("首行缩进", prefs.firstLineIndent, () => run("appearance:indent"));
  checkRow("代码行号", prefs.codeLineNumbers, () => run("appearance:code-ln"));

  const actions = document.createElement("div");
  actions.className = "menu-form-actions";
  for (const [label, cmd] of [["主题商店…", "theme-store"], ["打开主题文件夹", "theme-folder"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.addEventListener("click", () => {
      close();
      run(cmd);
    });
    actions.appendChild(btn);
  }
  form.appendChild(actions);
  host.appendChild(form);
}

const MENUS = [
  {
    id: "file",
    get label() { return t("menu.file"); },
    mnemonic: "F",
    items: () => {
      const recent = readRecent().map((p, i) => ({
        label: p.split(/[\\/]/).pop(),
        cmd: "recent:" + i,
      }));
      return [
        { label: t("menu.new"), cmd: "new", accel: ACCEL.new },
        { label: t("menu.open"), cmd: "open", accel: ACCEL.open },
        { label: t("menu.quickOpen"), cmd: "quick-open", accel: ACCEL["quick-open"] },
        ...(recent.length ? [{ type: "sep" }, ...recent] : []),
        { type: "sep" },
        { label: t("menu.save"), cmd: "save", accel: ACCEL.save },
        { label: t("menu.saveAs"), cmd: "save-as", accel: ACCEL["save-as"] },
        { type: "sep" },
        {
          label: t("menu.export"),
          submenu: () => [
            { label: t("menu.exportHtml"), cmd: "export-html" },
            { label: t("menu.exportHtmlBare"), cmd: "export-html-bare" },
            { type: "sep" },
            { label: t("menu.exportDocx"), cmd: "export-docx" },
            { label: t("menu.exportRtf"), cmd: "export-rtf" },
            { label: t("menu.exportEpub"), cmd: "export-epub" },
            { label: t("menu.exportLatex"), cmd: "export-latex" },
            { label: t("menu.exportPng"), cmd: "export-png" },
            { label: t("menu.exportPdf"), cmd: "export-pdf", accel: ACCEL["export-pdf"] },
          ],
        },
        { type: "sep" },
        { label: t("menu.closeWindow"), cmd: "close-window" },
      ];
    },
  },
  {
    id: "view",
    get label() { return t("menu.view"); },
    mnemonic: "V",
    items: () => [
      {
        label: t("menu.fileTree"),
        cmd: "view-files",
        accel: ACCEL["view-files"],
        checked: () => sidebarVisible() && sideView() === "files",
      },
      {
        label: t("menu.outline"),
        cmd: "view-outline",
        accel: ACCEL["view-outline"],
        checked: () => sidebarVisible() && sideView() === "outline",
      },
      {
        label: t("menu.showSidebar"),
        cmd: "toggle-sidebar",
        checked: () => sidebarVisible(),
      },
      {
        label: t("menu.showTabs"),
        cmd: "toggle-tabs",
        checked: () => shell.tabsVisible,
      },
      { type: "sep" },
      {
        label: t("menu.sourceMode"),
        cmd: "source-mode",
        accel: ACCEL["source-mode"],
        checked: isSourceMode,
      },
      {
        label: t("menu.focusMode"),
        cmd: "focus",
        accel: ACCEL.focus,
        checked: () => document.body.classList.contains("focus-mode"),
      },
      {
        label: t("menu.typewriter"),
        cmd: "typewriter",
        accel: ACCEL.typewriter,
        checked: () => state.typewriter,
      },
      { type: "sep" },
      {
        label: t("menu.spellcheck"),
        cmd: "appearance:spell",
        checked: () => getAppearance().spellcheck,
      },
      { label: t("menu.settings"), cmd: "settings" },
    ],
  },
  {
    id: "image",
    get label() { return t("menu.images"); },
    mnemonic: "I",
    items: () => [
      { label: t("menu.insertImage"), cmd: "image" },
      { type: "sep" },
      { label: t("menu.uploadImages"), cmd: "upload-document-images" },
      { type: "sep" },
      { label: t("menu.imageSettings"), cmd: "image-settings" },
    ],
  },
  {
    id: "theme",
    get label() { return t("menu.theme"); },
    mnemonic: "T",
    render: renderThemeMenuPage,
  },
  {
    id: "help",
    get label() { return t("menu.help"); },
    mnemonic: "H",
    items: () => [
      { label: t("menu.shortcuts"), cmd: "shortcuts", accel: ACCEL.shortcuts },
      { label: t("menu.checkUpdate"), cmd: "check-update" },
      { label: t("menu.settings"), cmd: "settings" },
      { label: t("menu.license"), cmd: "license" },
      { label: t("menu.about"), cmd: "about" },
    ],
  },
];

const menubar = createMenubar({
  bar: document.getElementById("menubar"),
  pop: document.getElementById("menu-pop"),
  menus: MENUS,
  run: (cmd) => run(cmd),
  backLabel: t("menu.back"),
});

// 菜单收起后把焦点还给编辑器，和原生菜单一致
document.addEventListener("menubar:closed", () => view.focus());
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
  onTexReady(() => view.dispatch({ effects: refreshDecorations.of(null) }));
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
      "未保存的修改",
      (body, close) => {
        const text = document.createElement("p");
        text.className = "settings-note";
        text.textContent = "是否保存更改？";
        const hint = document.createElement("p");
        hint.className = "settings-note";
        hint.textContent = "如果不保存，您的更改将会丢失。";

        // Typora 式排布：主操作靠左（保存 / 不保存），取消单独靠右。
        const row = document.createElement("div");
        row.className = "ask-actions";
        const main = document.createElement("div");
        main.className = "ask-group";
        const side = document.createElement("div");
        side.className = "ask-group";
        for (const [label, value, kind, group] of [
          ["保存并关闭", "save", "primary", main],
          ["不保存", "discard", "danger", main],
          ["取消", "cancel", "ghost", side],
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
  if (await settleCurrentDocument()) window.studio?.quit();
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

return {
  run,
  openPath: openTreePath,
  openSearchHit: openSearchedFile,
  openTab,
  closeTab,
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
