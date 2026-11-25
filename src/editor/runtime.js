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
import { createQuickInsert } from "./quick-insert.js";
import {
  headingFoldExtension,
  foldCurrentHeading,
  unfoldCurrentHeading,
  foldAllHeadings,
  unfoldAllHeadings,
} from "./heading-fold.js";
import {
  loadDraftList,
  upsertDraftEntry,
  removeDraftEntry,
  clearAllDraftEntries,
  draftPreviewText,
} from "./draft-recovery.js";
import { createContextMenu } from "./context-menu.js";
import { createImageOps } from "./image-ops.js";
import { createSettingsModal } from "./settings-modal.js";
import { computeWordGoalProgress, countParagraphs, panguSpacing, resolveImageFolder } from "./extrasText.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  undo,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Autolink } from "@lezer/markdown";
import { codeLanguages } from "./code-languages.js";
import {
  HighlightStyle,
  indentOnInput,
  indentUnit,
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
  blockViewportField,
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
import {
  DEFAULT_INDENT_WIDTH,
  codeBlockEnter,
  continueList,
  continueQuote,
  handleShiftTab,
  handleTab,
  outdentSoftTabOnBackspace,
  softNewline,
} from "./typing-ergonomics.js";
import { detectCode, pasteAsCodeBlock } from "./paste-code.js";
import { renderSelectionForClipboard, resolveImageForClipboard } from "./clipboard.js";
import { renderWeChatHtml } from "./wechat-html.js";
import { createJumpHistory, FONT_SIZE_DEFAULT, stepFontSize } from "./jump-history.js";
import { createTabsManager } from "./tabs.js";
import { createFileIO } from "./file-io.js";
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
  WORD_GOAL_KEY,
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
  clearTableCells,
  deleteTableCol,
  deleteTableRow,
  formatTableCells,
  insertTableCol,
  insertTableRow,
  moveTableCol,
  moveTableColsBlock,
  moveTableRow,
  moveTableRowsBlock,
  pasteTableCells,
  serializeTableSelection,
  setAlign,
  setAlignCols,
  sortTableRows,
} from "./table-model.js";
import { openTablePicker } from "./table-picker.js";
import {
  clearTableSelection,
  getActiveTableSelection,
  paintTableSelection,
  selectedCols,
  selectedRows,
  setTableSelection,
  tableSelectionBounds,
} from "./table-selection.js";
import { cancelCellEditor, commitCellEditor, editTable, formatTable } from "./table-edit.js";
import { normalizeMarkdownText, parseImageAttrs, scanTables, splitTableRow } from "./rich-doc.js";
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
      createQuickInsert({
        onCommand: (cmd) => {
          if (cmd === "insert-table") pickTableSize();
        },
      }),
      headingFoldExtension(),
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
      EditorState.tabSize.of(DEFAULT_INDENT_WIDTH),
      indentUnit.of(" ".repeat(DEFAULT_INDENT_WIDTH)),
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
          { key: "Enter", run: (v) => codeBlockEnter(v, DEFAULT_INDENT_WIDTH, inCodeBlock) },
          { key: "Enter", run: (v) => continueList(v, { tabSize: DEFAULT_INDENT_WIDTH, isCodeBlock: inCodeBlock }) },
          { key: "Enter", run: (v) => continueQuote(v, { tabSize: DEFAULT_INDENT_WIDTH, isCodeBlock: inCodeBlock }) },
          { key: "Enter", run: newlineAfterLazyQuote },
          { key: "Shift-Enter", run: (v) => softNewline(v, { isCodeBlock: inCodeBlock }) },
          { key: "Tab", run: (v) => handleTab(v, { indentWidth: DEFAULT_INDENT_WIDTH, tabSize: DEFAULT_INDENT_WIDTH, isCodeBlock: inCodeBlock }) },
          { key: "Shift-Tab", run: (v) => handleShiftTab(v, { indentWidth: DEFAULT_INDENT_WIDTH, tabSize: DEFAULT_INDENT_WIDTH, isCodeBlock: inCodeBlock }) },
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
          // 代码块内软缩进纯空白行首：Backspace 按缩进宽度整步回删
          { key: "Backspace", run: (v) => outdentSoftTabOnBackspace(v, DEFAULT_INDENT_WIDTH, inCodeBlock) },
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
      blockViewportField,
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
        {
          key: "Mod-0",
          run: () => {
            const lineText = view.state.doc.lineAt(view.state.selection.main.head).text;
            if (/^\s{0,3}#{1,6}\s+/.test(lineText)) setHeading(0);
            else resetFontSize();
            return true;
          },
        },
        { key: "Mod-=", run: () => (adjustFontSize(1), true) },
        { key: "Mod-Shift-=", run: () => (adjustFontSize(1), true) },
        { key: "Mod--", run: () => (adjustFontSize(-1), true) },
        { key: "Mod-Shift-0", run: () => (resetFontSize(), true) },
        { key: "Alt-ArrowLeft", run: () => (jumpBack(), true) },
        { key: "Alt-ArrowRight", run: () => (jumpForward(), true) },
        { key: "Mod-Shift-1", run: () => (showSide("outline"), true) },
        { key: "Mod-Shift-e", run: () => (showSide("files"), true) },
        { key: "Mod-Shift-f", run: () => (focusFileSearch(), true) },
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
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          setDirty(true);
          scheduleAutosave();
          scheduleOutline();
        }
        if (u.docChanged || u.selectionSet) scheduleStatus();
        if (u.selectionSet) {
          trackCursorJump(u);
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
  const text = view.state.doc.toString();
  const chars = text.length;
  const noWs = (text.match(/\S/g) || []).length;
  const words = countWords(text);
  const lines = view.state.doc.lines;
  const mins = words === 0 ? 0 : Math.max(1, Math.ceil(words / 400));
  const pop = document.getElementById("stats-pop");
  const row = (label, value) =>
    `<div class="stats-row"><span>${label}</span><b>${value}</b></div>`;
  const paras = countParagraphs(text);
  const goal = getWordGoal(state.path);
  shell.setWordGoal(goal);
  const gp = computeWordGoalProgress(words, goal);
  const goalStatus = gp.goal
    ? gp.reached
      ? `已达成（${gp.percent}%）`
      : `${gp.percent}% · 还差 ${gp.remaining.toLocaleString()} 字`
    : "未设置";
  pop.innerHTML =
    "<h4>文档统计</h4>" +
    row("字数", words.toLocaleString()) +
    row("字符", chars.toLocaleString()) +
    row("字符（不含空格）", noWs.toLocaleString()) +
    row("段落", paras.toLocaleString()) +
    row("行数", lines.toLocaleString()) +
    row("阅读时间", mins ? `约 ${mins} 分钟` : "不到 1 分钟") +
    `<div class="stats-goal">` +
    `<label class="stats-goal-row"><span>单篇字数目标</span>` +
    `<input id="stats-goal-input" type="number" min="0" step="100" value="${gp.goal || ""}" placeholder="如 2000"></label>` +
    `<div class="stats-goal-meta"><span>进度</span><b>${goalStatus}</b></div>` +
    `<div class="stats-goal-track"><div class="stats-goal-fill${gp.reached ? " is-reached" : ""}" style="width:${gp.percent}%"></div></div>` +
    `</div>`;
  const input = pop.querySelector("#stats-goal-input");
  if (input) {
    input.addEventListener("change", () => {
      setWordGoalForDoc(input.value, state.path);
      renderStatsPop();
    });
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        setWordGoalForDoc(input.value, state.path);
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
  removeDraftEntry(state.path);
}

function writeDraft() {
  clearTimeout(draftTimer);
  if (!state.dirty) return;
  const snapshot = {
    path: state.path,
    content: view.state.doc.toString(),
    eol: state.eol,
    bom: state.bom,
    encoding: state.encoding,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot));
  } catch {
    /* 配额不足或隐私模式下退化为普通未保存提示 */
  }
  upsertDraftEntry(snapshot);
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

function restoreDraftItem(draft) {
  if (!draft || typeof draft.content !== "string") return;
  loadDoc(draft.content, typeof draft.path === "string" ? draft.path : null);
  if (draft.eol === "\r\n" || draft.eol === "\n") state.eol = draft.eol;
  if (typeof draft.bom === "boolean") state.bom = draft.bom;
  if (typeof draft.encoding === "string" && draft.encoding) state.encoding = draft.encoding;
  setDirty(true);
  writeDraft();
  flash(`已恢复未保存草稿：${draft.name || "未命名.md"}`);
}

function escHtml(str) {
  return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function openDraftRecoveryModal() {
  const list = loadDraftList();
  if (!list.length) {
    openSheet(
      "未保存草稿恢复",
      `<p class="settings-note">当前没有可恢复的未保存草稿。</p>` +
        `<div class="settings-actions"><button type="button" id="draft-close" class="settings-btn">关闭</button></div>`,
    );
    document.getElementById("draft-close")?.addEventListener("click", closeSettings);
    return;
  }
  const rows = list
    .map((d, idx) => {
      const timeStr = new Date(d.updatedAt).toLocaleString();
      const words = countWords(d.content).toLocaleString();
      return (
        `<div class="draft-item" data-idx="${idx}">` +
        `<div class="draft-head"><b>${escHtml(d.name)}</b><span class="draft-meta">${words} 字 · ${escHtml(timeStr)}</span></div>` +
        (d.path ? `<div class="draft-path" title="${escHtml(d.path)}">${escHtml(d.path)}</div>` : "") +
        `<div class="draft-preview">${escHtml(draftPreviewText(d.content))}</div>` +
        `<div class="draft-actions">` +
        `<button type="button" class="settings-btn draft-restore" data-idx="${idx}">恢复此草稿</button>` +
        `<button type="button" class="settings-btn draft-delete" data-idx="${idx}">删除</button>` +
        `</div></div>`
      );
    })
    .join("");
  openSheet(
    `未保存草稿恢复（${list.length}）`,
    `<p class="settings-note">按文档自动保留最近未保存快照，可随时选择恢复或清理。</p>` +
      `<div class="draft-list">${rows}</div>` +
      `<div class="settings-actions">` +
      `<button type="button" id="draft-clear-all" class="settings-btn">清空全部草稿</button>` +
      `<button type="button" id="draft-close" class="settings-btn">关闭</button>` +
      `</div>`,
  );
  const body = document.getElementById("settings-body");
  body?.querySelectorAll(".draft-restore").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = list[Number(btn.dataset.idx)];
      closeSettings();
      if (item) restoreDraftItem(item);
    });
  });
  body?.querySelectorAll(".draft-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = list[Number(btn.dataset.idx)];
      if (item) removeDraftEntry(item.id);
      openDraftRecoveryModal();
    });
  });
  document.getElementById("draft-clear-all")?.addEventListener("click", () => {
    clearAllDraftEntries();
    closeSettings();
    flash("已清空所有未保存草稿");
  });
  document.getElementById("draft-close")?.addEventListener("click", closeSettings);
}

async function offerDraftRecovery() {
  const list = loadDraftList();
  if (list.length > 1) {
    openDraftRecoveryModal();
    return;
  }
  let draft = list[0] || null;
  if (!draft && STARTUP_DRAFT) {
    try {
      draft = JSON.parse(STARTUP_DRAFT);
    } catch {
      clearDraft();
      return;
    }
  }
  if (!draft || typeof draft.content !== "string") return;
  const restore = window.studio?.confirm
    ? await window.studio.confirm(`检测到上次未保存的草稿（${draft.name || "未命名.md"}），是否恢复？`)
    : window.confirm(`检测到上次未保存的草稿（${draft.name || "未命名.md"}），是否恢复？`);
  if (!restore) {
    removeDraftEntry(draft.id || draft.path);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  restoreDraftItem(draft);
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

const { showContextMenu } = createContextMenu({ flash: (msg) => flash(msg) });


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
  recordJumpOrigin();
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
  recordJumpOrigin();
  const isFirstLine = index === 0 && view.state.doc.lineAt(pos).number === 1;
  // 先聚焦再改选区，确保 CM 同步写入 DOM Selection；否则后聚焦时浏览器会按旧选区把滚动条拉回去。
  view.contentDOM.focus({ preventScroll: true });
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, {
      y: index === 0 ? "start" : "center",
      yMargin: isFirstLine ? 80 : 56,
    }),
  });
  unfoldCurrentHeading(view);
  if (isFirstLine) {
    view.scrollDOM.scrollTo({ top: 0 });
  }
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
/** 读取指定首行行号的表格源码二维数组（[header, delim, ...body]），供多选区复制/操作使用。 */
function readTableGrid(lineNo) {
  const table = scanTables(view.state.doc).find((tb) => tb.startLine === lineNo);
  if (!table) return null;
  const rows = [];
  for (let n = table.startLine; n <= table.endLine; n++) {
    rows.push(splitTableRow(view.state.doc.line(n).text).map((c) => c.raw));
  }
  return rows;
}

function clearAllTableSelections() {
  clearTableSelection();
  for (const el of document.querySelectorAll(".cm-table-wrap .is-selected")) {
    el.classList.remove("is-selected");
  }
}

async function copyTableSelectionArea(lineNo, bounds, { asMarkdown = false, cut = false } = {}) {
  const grid = readTableGrid(lineNo);
  if (!grid || !bounds) return false;
  const { tsv, markdown, html } = serializeTableSelection(grid, bounds);
  const plain = asMarkdown ? markdown : tsv;
  try {
    if (!asMarkdown && window.ClipboardItem) {
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
      return false;
    }
  }
  const rCount = bounds.r2 - bounds.r1 + 1;
  const cCount = bounds.c2 - bounds.c1 + 1;
  if (cut) {
    await editTable(view, lineNo, (rows) => clearTableCells(rows, bounds));
    flash(`已剪切 ${rCount} 行 × ${cCount} 列`);
  } else {
    flash(asMarkdown ? `已复制 ${rCount} 行 × ${cCount} 列（Markdown）` : `已复制 ${rCount} 行 × ${cCount} 列`);
  }
  return true;
}

async function pasteIntoTableSelection(lineNo, bounds, textOverride = null) {
  if (!bounds) return false;
  let clip = textOverride;
  if (clip == null) {
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      flash("无法读取剪贴板");
      return false;
    }
  }
  if (!clip) return false;
  const ok = await editTable(view, lineNo, (rows) => pasteTableCells(rows, bounds, clip));
  if (ok) flash("已粘贴到选中单元格");
  return ok;
}

/** 表格多选全局键盘操作：Delete/Backspace 清空、Ctrl+C/X/V 复剪粘、Ctrl+B/I/E/Shift+X 批量格式、Alt+方向键整块移动、Esc 取消选中。 */
document.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  // 正在单元格浮层 textarea 或弹窗输入框里打字时不拦截
  const activeTag = document.activeElement?.tagName;
  if (activeTag === "TEXTAREA" || activeTag === "INPUT") return;
  const activeSel = getActiveTableSelection();
  if (!activeSel) return;
  const { lineNo, bounds } = activeSel;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    clearAllTableSelections();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && !mod && !e.altKey) {
    e.preventDefault();
    e.stopPropagation();
    const count = (bounds.r2 - bounds.r1 + 1) * (bounds.c2 - bounds.c1 + 1);
    editTable(view, lineNo, (rows) => clearTableCells(rows, bounds)).then((ok) => {
      if (ok) flash(`已清空 ${count} 个单元格`);
    });
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && k === "c") {
    e.preventDefault();
    e.stopPropagation();
    copyTableSelectionArea(lineNo, bounds, { cut: false });
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && k === "x") {
    e.preventDefault();
    e.stopPropagation();
    copyTableSelectionArea(lineNo, bounds, { cut: true });
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && k === "v") {
    e.preventDefault();
    e.stopPropagation();
    pasteIntoTableSelection(lineNo, bounds);
    return;
  }
  if (mod && !e.altKey && !e.shiftKey && (k === "b" || k === "i" || k === "e")) {
    e.preventDefault();
    e.stopPropagation();
    const marker = k === "b" ? "**" : k === "i" ? "*" : "`";
    editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, marker));
    return;
  }
  if (mod && !e.altKey && e.shiftKey && k === "x") {
    e.preventDefault();
    e.stopPropagation();
    editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, "~~"));
    return;
  }
  if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const selR = selectedRows(lineNo).filter((r) => r >= 1);
    if (!selR.length) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.key === "ArrowUp" ? -1 : 1;
    editTable(view, lineNo, (rows) => moveTableRowsBlock(rows, selR, delta)).then((ok) => {
      if (ok) {
        setTableSelection(
          lineNo,
          { row: bounds.r1 + delta, col: bounds.c1 },
          { row: bounds.r2 + delta, col: bounds.c2 },
        );
      }
    });
    return;
  }
  if (e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const selC = selectedCols(lineNo);
    if (!selC.length) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.key === "ArrowLeft" ? -1 : 1;
    editTable(view, lineNo, (rows) => moveTableColsBlock(rows, selC, delta)).then((ok) => {
      if (ok) {
        setTableSelection(
          lineNo,
          { row: bounds.r1, col: bounds.c1 + delta },
          { row: bounds.r2, col: bounds.c2 + delta },
        );
      }
    });
  }
}, true);

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
          {
            label: "清空选中单元格",
            accel: "Delete",
            action: () =>
              editTable(view, lineNo, (rows) => clearTableCells(rows, bounds)).then((ok) => {
                if (ok) flash(`已清空 ${selRows.length * selCols.length} 个单元格`);
              }),
          },
          {
            label: "复制选中区域",
            accel: "Ctrl+C",
            action: () => copyTableSelectionArea(lineNo, bounds, { cut: false }),
          },
          {
            label: "剪切选中区域",
            accel: "Ctrl+X",
            action: () => copyTableSelectionArea(lineNo, bounds, { cut: true }),
          },
          {
            label: "粘贴到选中区域",
            accel: "Ctrl+V",
            action: () => pasteIntoTableSelection(lineNo, bounds),
          },
          {
            label: "批量格式",
            children: [
              { label: "加粗", accel: "Ctrl+B", action: () => editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, "**")) },
              { label: "斜体", accel: "Ctrl+I", action: () => editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, "*")) },
              { label: "行内代码", accel: "Ctrl+E", action: () => editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, "`")) },
              { label: "删除线", accel: "Ctrl+Shift+X", action: () => editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, "~~")) },
              { separator: true },
              { label: "清除行内格式", action: () => editTable(view, lineNo, (rows) => formatTableCells(rows, bounds, null)) },
            ],
          },
          { label: "取消选择", accel: "Esc", action: () => { clearTableSelection(lineNo); paintTableSelection(wrap, lineNo); } },
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
      label: manyRows ? `移动选中的 ${selRows.filter((r) => r >= 1).length} 行` : "移动该行",
      children: [
        {
          label: manyRows ? "整块上移" : "上移该行",
          accel: "Alt+↑",
          disabled: manyRows ? Math.min(...selRows.filter((r) => r >= 1), 0) <= 1 : row <= 1,
          action: () => {
            const targetRows = manyRows ? selRows.filter((r) => r >= 1) : [row];
            return editTable(view, lineNo, (rows) => moveTableRowsBlock(rows, targetRows, -1)).then((ok) => {
              if (ok && bounds) {
                setTableSelection(lineNo, { row: bounds.r1 - 1, col: bounds.c1 }, { row: bounds.r2 - 1, col: bounds.c2 });
              }
            });
          },
        },
        {
          label: manyRows ? "整块下移" : "下移该行",
          accel: "Alt+↓",
          disabled: manyRows ? !selRows.some((r) => r >= 1) || Math.max(...selRows) >= lastRow : row <= 0 || row >= lastRow,
          action: () => {
            const targetRows = manyRows ? selRows.filter((r) => r >= 1) : [row];
            return editTable(view, lineNo, (rows) => moveTableRowsBlock(rows, targetRows, 1)).then((ok) => {
              if (ok && bounds) {
                setTableSelection(lineNo, { row: bounds.r1 + 1, col: bounds.c1 }, { row: bounds.r2 + 1, col: bounds.c2 });
              }
            });
          },
        },
      ],
    },
    {
      label: manyCols ? `移动选中的 ${selCols.length} 列` : "移动该列",
      children: [
        {
          label: manyCols ? "整块左移" : "左移该列",
          accel: "Alt+←",
          disabled: manyCols ? bounds.c1 <= 0 : col <= 0,
          action: () => {
            const targetCols = manyCols ? selCols : [col];
            return editTable(view, lineNo, (rows) => moveTableColsBlock(rows, targetCols, -1)).then((ok) => {
              if (ok && bounds) {
                setTableSelection(lineNo, { row: bounds.r1, col: bounds.c1 - 1 }, { row: bounds.r2, col: bounds.c2 - 1 });
              }
            });
          },
        },
        {
          label: manyCols ? "整块右移" : "右移该列",
          accel: "Alt+→",
          disabled: manyCols ? bounds.c2 >= colCount - 1 : col >= colCount - 1,
          action: () => {
            const targetCols = manyCols ? selCols : [col];
            return editTable(view, lineNo, (rows) => moveTableColsBlock(rows, targetCols, 1)).then((ok) => {
              if (ok && bounds) {
                setTableSelection(lineNo, { row: bounds.r1, col: bounds.c1 + 1 }, { row: bounds.r2, col: bounds.c2 + 1 });
              }
            });
          },
        },
      ],
    },
    {
      label: manyCols ? `对齐方式（${selCols.length} 列）` : "对齐方式",
      children: [
        { label: "左对齐", action: () => editTable(view, lineNo, (rows) => setAlignCols(rows, manyCols ? selCols : [col], "left")) },
        { label: "居中", action: () => editTable(view, lineNo, (rows) => setAlignCols(rows, manyCols ? selCols : [col], "center")) },
        { label: "右对齐", action: () => editTable(view, lineNo, (rows) => setAlignCols(rows, manyCols ? selCols : [col], "right")) },
      ],
    },
    { separator: true },
    {
      label: manyRows ? `删除选中的 ${selRows.length} 行` : "删除行",
      disabled: lastRow <= 0,
      action: act((rows) => {
        if (!manyRows) return deleteTableRow(rows, row);
        for (const r of [...selRows].sort((a, b) => b - a)) deleteTableRow(rows, r);
      }),
    },
    {
      label: manyCols ? `删除选中的 ${selCols.length} 列` : "删除列",
      disabled: colCount <= 1,
      action: act((rows) => {
        if (!manyCols) return deleteTableCol(rows, col);
        for (const c of [...selCols].sort((a, b) => b - a)) deleteTableCol(rows, c);
      }),
    },
    { label: "删除表格", danger: true, action: deleteTable },
    { separator: true },
    { label: bounds ? "复制选中区域（Markdown）" : "复制表格", action: copyTable },
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
        { label: "复制为公众号 / 富文本样式", action: () => run("copy-wechat") },
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
        { label: "中英文自动加空格", action: () => run("format-spacing") },
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
    recordJumpOrigin();
    const isFirstLine = view.state.doc.lineAt(pos).number === 1;
    view.contentDOM.focus({ preventScroll: true });
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, {
        y: "start",
        yMargin: isFirstLine ? 80 : 56,
      }),
    });
    if (isFirstLine) {
      view.scrollDOM.scrollTo({ top: 0 });
    }
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
    if (allHave) {
      changes.push({
        from: line.from,
        to: line.from + m[0].length,
        insert: "",
      });
    } else if (!m) {
      const other = prefixFn.list ? ANY_LIST_PREFIX.exec(line.text) : null;
      if (other) {
        changes.push({
          from: line.from,
          to: line.from + other[0].length,
          insert: other[1] + prefixFn.insert,
        });
      } else {
        changes.push({ from: line.from, insert: prefixFn.insert });
      }
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

const quotePrefix = {
  insert: "> ",
  match: (text) => /^\s{0,3}>\s?/.exec(text),
};

const ANY_LIST_PREFIX = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/;

const ulPrefix = {
  list: true,
  insert: "- ",
  match: (text) => /^\s*[-*+]\s+(?!\[[ xX]\]\s+)/.exec(text),
};

const olPrefix = {
  list: true,
  insert: "1. ",
  match: (text) => /^\s*\d+[.)]\s+/.exec(text),
};

const taskPrefix = {
  list: true,
  insert: "- [ ] ",
  match: (text) => /^\s*[-*+]\s+\[[ xX]\]\s+/.exec(text),
};

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

/* ---------------- 多标签页与磁盘读写（已抽离至 tabs.js / file-io.js） ---------------- */

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

function buildPaletteCommands() {
  const base = [
    { category: "发布", label: "复制为公众号 / 富文本样式", cmd: "copy-wechat", keywords: "wechat 公众号 飞书 邮件 富文本 html" },
    { category: "导出", label: "导出为 PDF", cmd: "export-pdf", accel: ACCEL["export-pdf"], keywords: "pdf print 导出" },
    { category: "导出", label: "导出为 HTML（含样式）", cmd: "export-html", keywords: "html export" },
    { category: "导出", label: "导出为 Word (.docx)", cmd: "export-docx", keywords: "word docx" },
    { category: "导出", label: "导出为长图 PNG", cmd: "export-png", keywords: "png image 长图" },
    { category: "排版", label: "中英文自动加空格", cmd: "format-spacing", keywords: "pangu spacing 空格 盘古" },
    { category: "视图", label: "切换专注模式", cmd: "focus", accel: ACCEL.focus, keywords: "focus 专注" },
    { category: "视图", label: "切换打字机模式", cmd: "typewriter", accel: ACCEL.typewriter, keywords: "typewriter 打字机" },
    { category: "视图", label: "切换源代码模式", cmd: "source-mode", accel: ACCEL["source-mode"], keywords: "source 源码" },
    { category: "视图", label: "放大正文字号", cmd: "zoom-in", accel: ACCEL["zoom-in"], keywords: "font zoom 放大 字号" },
    { category: "视图", label: "缩小正文字号", cmd: "zoom-out", accel: ACCEL["zoom-out"], keywords: "font zoom 缩小 字号" },
    { category: "视图", label: "重置正文字号", cmd: "zoom-reset", accel: ACCEL["zoom-reset"], keywords: "font zoom 重置 字号" },
    { category: "导航", label: "返回上一处光标位置", cmd: "jump-back", accel: ACCEL["jump-back"], keywords: "back jump 后退 光标" },
    { category: "导航", label: "前进到下一处光标位置", cmd: "jump-forward", accel: ACCEL["jump-forward"], keywords: "forward jump 前进 光标" },
    { category: "大纲", label: "折叠当前章节（H1–H3）", cmd: "fold-heading", accel: ACCEL["fold-heading"], keywords: "fold 折叠 标题" },
    { category: "大纲", label: "展开当前章节（H1–H3）", cmd: "unfold-heading", accel: ACCEL["unfold-heading"], keywords: "unfold 展开 标题" },
    { category: "大纲", label: "折叠全部标题章节", cmd: "fold-all-headings", keywords: "fold all 全部折叠" },
    { category: "大纲", label: "展开全部标题章节", cmd: "unfold-all-headings", keywords: "unfold all 全部展开" },
    { category: "文件", label: "恢复未保存草稿", cmd: "draft-recovery", keywords: "draft recovery 草稿 恢复" },
    { category: "文件", label: "跨文件搜索与替换", cmd: "search-files", accel: ACCEL["search-files"], keywords: "search replace 搜索" },
    { category: "设置", label: "打开外观与编辑器设置", cmd: "settings", keywords: "settings preferences 设置" },
    { category: "设置", label: "打开主题商店", cmd: "theme-store", keywords: "theme store 主题" },
    { category: "帮助", label: "查看快捷键一览", cmd: "shortcuts", accel: ACCEL.shortcuts, keywords: "shortcuts keymap 快捷键" },
  ];
  const themeCmds = THEMES.map((th) => ({
    category: "主题",
    label: `切换主题：${th.label}`,
    cmd: `theme:${th.id}`,
    keywords: `theme 主题 ${th.id} ${th.label}`,
  }));
  return [...base, ...themeCmds];
}

const quickOpen = createQuickOpen({
  state,
  openSheet,
  flash,
  openFile,
  settleCurrentDocument,
  openDiskDoc,
  samePath,
  getCommands: buildPaletteCommands,
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
  "format-spacing": () => {
    const orig = view.state.doc.toString();
    const next = panguSpacing(orig);
    if (next === orig) {
      flash("中英文间距已规范");
      return;
    }
    const head = Math.min(view.state.selection.main.head, next.length);
    view.dispatch({
      changes: { from: 0, to: orig.length, insert: next },
      selection: { anchor: head },
    });
    flash("已为中英文混排补齐空格");
    view.focus();
  },
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
  "search-files": () => focusFileSearch(),
  "draft-recovery": () => openDraftRecoveryModal(),
  "fold-heading": () => {
    if (!foldCurrentHeading(view)) flash("当前位置不在可折叠的 H1–H3 章节内");
  },
  "unfold-heading": () => unfoldCurrentHeading(view),
  "fold-all-headings": () => foldAllHeadings(view),
  "unfold-all-headings": () => unfoldAllHeadings(view),
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
  "copy-wechat": () => copyAsWeChatHtml(),
  "zoom-in": () => adjustFontSize(1),
  "zoom-out": () => adjustFontSize(-1),
  "zoom-reset": () => resetFontSize(),
  "jump-back": () => jumpBack(),
  "jump-forward": () => jumpForward(),
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

/**
 * 一键复制为公众号 / 飞书 / 邮件富文本 HTML（复用当前主题 CSS 变量生成全内联样式）。
 */
async function copyAsWeChatHtml() {
  const s = view.state;
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
    imageResolver: (srcUrl) => resolveImageForClipboard(srcUrl, state.dir),
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
fileIO.bindExternalChange();

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
        { label: "恢复未保存草稿…", cmd: "draft-recovery" },
        { type: "sep" },
        {
          label: t("menu.export"),
          submenu: () => [
            { label: "复制为公众号 / 富文本样式", cmd: "copy-wechat" },
            { type: "sep" },
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
      { type: "sep" },
      { label: "跨文件搜索与替换", cmd: "search-files", accel: ACCEL["search-files"] },
      { label: "折叠当前章节", cmd: "fold-heading", accel: ACCEL["fold-heading"] },
      { label: "展开当前章节", cmd: "unfold-heading", accel: ACCEL["unfold-heading"] },
      { label: "折叠全部标题章节", cmd: "fold-all-headings" },
      { label: "展开全部标题章节", cmd: "unfold-all-headings" },
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

return {
  run,
  openPath: openTreePath,
  reloadModifiedFiles,
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
