import { ChangeSet, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder, rectangularSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Autolink } from "@lezer/markdown";
import { HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { codeLanguages } from "./code-languages.js";
import { codeSelectionFit } from "./selection-fit.js";
import { caretFit, dropCursor } from "./caret-fit.js";
import { createQuickInsert } from "./quick-insert.js";
import { headingFoldExtension } from "./heading-fold.js";
import { inCodeBlock, newlineAfterLazyQuote } from "./editor-formatting.js";
import {
  blockDecorations,
  blockViewportField,
  livePreview,
  sourceModeField,
} from "./live-preview.js";
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
import { renderSelectionForClipboard } from "./clipboard.js";
import { docBaseField, editingImageField } from "./widgets.js";

export const codeHighlight = HighlightStyle.define([
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

export const zhPhrases = EditorState.phrases.of({
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

export const editingTheme = EditorView.theme({
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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
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
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": {
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

/**
 * 构建主栏与分栏共享的 CodeMirror 扩展栈。
 * 回调均通过外层传入，避免与运行时命令、图片或文件系统状态产生循环依赖。
 */
export function createEditorSetup({
  getPrimaryView,
  getFormatting,
  pickTableSize,
  attachImage,
  insertAtCursor,
  flash,
  handlePastedText,
  copyMarkdownSelection,
  run,
  openFile,
  quickOpen,
  newDoc,
  saveAs,
  doExportPdf,
  adjustFontSize,
  resetFontSize,
  jumpBack,
  jumpForward,
  showSide,
  focusFileSearch,
}) {
  function createEditorExtensions({ historySlot: slot, getDocState, onUpdate, onFocus }) {
    return [
      slot.of(history()),
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
       */
      Prec.highest(
        EditorView.domEventHandlers({
          // 注意签名是 (event, view)：CM 内部用 handler.call(plugin, event, view) 调。
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
                  if (v === getPrimaryView() && window.studio) {
                    await attachImage(await file.arrayBuffer(), ext);
                  } else {
                    insertAtCursor(`![](${URL.createObjectURL(file)})`, undefined, v);
                    if (v === getPrimaryView()) flash("浏览器模式下图片不会落盘");
                  }
                })();
              }
              return true;
            }
            if (handlePastedText(data.getData("text/plain"), v)) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          copy(event, v) {
            const sel = v.state.selection;
            if (sel.main.empty || !event.clipboardData) return false;
            const { html, plain } = renderSelectionForClipboard(v.state, getDocState().dir);
            if (!plain && !html) return false;
            event.preventDefault();
            event.clipboardData.setData("text/plain", plain);
            event.clipboardData.setData("text/html", html);
            return true;
          },
          cut(event, v) {
            const sel = v.state.selection;
            if (sel.main.empty || !event.clipboardData) return false;
            const { html, plain } = renderSelectionForClipboard(v.state, getDocState().dir);
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
          focus(_event, v) {
            onFocus?.(v);
            return false;
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
       */
      Prec.high(
        keymap.of([
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
          { key: "ArrowLeft", run: (v) => navigateFence(v, "left") },
          { key: "ArrowRight", run: (v) => navigateFence(v, "right") },
          { key: "ArrowUp", run: (v) => navigateFence(v, "up") },
          { key: "ArrowDown", run: (v) => navigateFence(v, "down") },
          { key: "Backspace", run: exitHeadingOnBackspace },
          { key: "Delete", run: exitHeadingOnDelete },
          { key: "Backspace", run: deleteEmptyFence },
          { key: "Backspace", run: exitListOnBackspace },
          { key: "Backspace", run: exitQuoteOnBackspace },
          { key: "Delete", run: deleteEmptyFence },
          {
            key: "Backspace",
            run: (v) => (v.state.field(sourceModeField, false) ? false : protectFenceBackspace(v)),
          },
          {
            key: "Delete",
            run: (v) => (v.state.field(sourceModeField, false) ? false : protectFenceDelete(v)),
          },
          { key: "Backspace", run: (v) => outdentSoftTabOnBackspace(v, DEFAULT_INDENT_WIDTH, inCodeBlock) },
          { key: "Backspace", run: deletePair },
          { key: "Delete", run: deletePairForward },
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
      docBaseField,
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
        { key: "Mod-s", run: () => (run("save"), true) },
        { key: "Mod-o", run: () => (openFile(), true) },
        { key: "Mod-Shift-p", run: () => (quickOpen(), true) },
        { key: "Mod-b", run: (v) => (getFormatting().wrap("**", "**", v), true) },
        { key: "Mod-i", run: (v) => (getFormatting().wrap("*", "*", v), true) },
        { key: "Mod-k", run: (v) => (getFormatting().insertLink(v), true) },
        { key: "Mod-Shift-k", run: (v) => (getFormatting().insertFence(v), true) },
        { key: "Mod-Shift-m", run: (v) => (getFormatting().insertMathBlock(v), true) },
        { key: "Mod-Shift-t", run: () => (run("table"), true) },
        { key: "Mod-1", run: (v) => (getFormatting().setHeading(1, v), true) },
        { key: "Mod-2", run: (v) => (getFormatting().setHeading(2, v), true) },
        { key: "Mod-3", run: (v) => (getFormatting().setHeading(3, v), true) },
        { key: "Mod-4", run: (v) => (getFormatting().setHeading(4, v), true) },
        { key: "Mod-5", run: (v) => (getFormatting().setHeading(5, v), true) },
        { key: "Mod-6", run: (v) => (getFormatting().setHeading(6, v), true) },
        {
          key: "Mod-0",
          run: (v) => {
            const lineText = v.state.doc.lineAt(v.state.selection.main.head).text;
            if (/^\s{0,3}#{1,6}\s+/.test(lineText)) getFormatting().setHeading(0, v);
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
        { key: "Mod-e", run: (v) => (getFormatting().wrap("`", "`", v), true) },
        { key: "Mod-Shift-x", run: (v) => (getFormatting().wrap("~~", "~~", v), true) },
        // historyKeymap 里 Ctrl+Shift+Z 只是 mac 变体，Windows 上要自己补一条（Ctrl+Y 仍然可用）
        { key: "Mod-Shift-z", run: (v) => (redo(v), true) },
        // Ctrl+V 交给 Chromium 原生粘贴，纯文本走我们自己的实现（它会读到富文本/图片）
        { key: "Mod-Shift-v", run: () => (run("paste-plain"), true) },
        // 源代码模式：markdown 没有「注释」概念，Mod-/ 不会和 defaultKeymap 抢
        { key: "Mod-/", run: () => (run("source-mode"), true) },
        { key: "F1", run: () => (run("shortcuts"), true) },
        { key: "F8", run: () => (run("focus"), true) },
        { key: "F9", run: () => (run("typewriter"), true) },
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => onUpdate(u)),
    ];
  }

  return { createEditorExtensions };
}
