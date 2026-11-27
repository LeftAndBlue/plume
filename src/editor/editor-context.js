import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { ACCEL } from "./shortcuts.js";
import { formatImageMd, parseImageMd, setEditingImage } from "./widgets.js";
import {
  clearTableCells,
  deleteTableCol,
  deleteTableRow,
  formatTableCells,
  insertTableCol,
  insertTableRow,
  moveTableColsBlock,
  moveTableRowsBlock,
  pasteTableCells,
  serializeTableSelection,
  setAlignCols,
  sortTableRows,
} from "./table-model.js";
import {
  clearTableSelection,
  getActiveTableSelection,
  paintTableSelection,
  selectedCols,
  selectedRows,
  setTableSelection,
  tableSelectionBounds,
} from "./table-selection.js";
import { commitCellEditor, editTable, formatTable } from "./table-edit.js";
import { parseImageAttrs, scanTables, splitTableRow } from "./rich-doc.js";

/**
 * 编辑器交互与右键上下文菜单控制器：
 * 包含表格多选快捷键与菜单、图片属性与目录整理菜单、正文上下文菜单，以及 Ctrl/Cmd+点击链接跳转。
 */
export function createEditorContext({
  getPrimaryView,
  activeView,
  state,
  focusPane,
  showContextMenu,
  flash,
  copyText,
  askText,
  currentImageFolder,
  uploadImageFromMenu,
  headingPosBySlug,
  recordJumpOrigin,
  run,
}) {
  function readTableGrid(lineNo) {
    const view = getPrimaryView();
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
    const view = getPrimaryView();
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
    const view = getPrimaryView();
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
    const view = getPrimaryView();
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
    const view = getPrimaryView();
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
    const doc = getPrimaryView().state.doc;
    let from = Number(el.dataset.from);
    let to = Number(el.dataset.to);
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
    const view = getPrimaryView();
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
    const view = getPrimaryView();
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
    const view = getPrimaryView();
    const info = imageSourceRange(el);
    if (!info || !info.raw.includes("![")) return flash("图片源码位置已变化，请重试");
    view.dispatch({ changes: { from: info.from, to: info.to, insert: "" }, selection: { anchor: info.from } });
    flash("已删除图片引用，源文件未改动");
  }

  async function relocateImage(el, move) {
    const view = getPrimaryView();
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
   * 正文右键菜单：照 Typora 的段落面板排——图标行 + 多列按钮网格 + 分组的二级菜单。
   */
  function baseEditorContextItems(targetView = activeView()) {
    const empty = targetView.state.selection.main.empty;
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
            action: () => targetView.dispatch(targetView.state.replaceSelection("")),
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

  function openLink(href, targetView = activeView()) {
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
      const pos = headingPosBySlug(slug, targetView);
      if (pos < 0) return false;
      if (targetView === getPrimaryView()) recordJumpOrigin();
      const isFirstLine = targetView.state.doc.lineAt(pos).number === 1;
      targetView.contentDOM.focus({ preventScroll: true });
      targetView.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, {
          y: "start",
          yMargin: isFirstLine ? 80 : 56,
        }),
      });
      if (isFirstLine) {
        targetView.scrollDOM.scrollTo({ top: 0 });
      }
      return true;
    }
    if (/^(https?:|mailto:)/i.test(url)) {
      window.studio
        ?.openExternal(url)
        ?.catch((e) => flash("无法打开链接：" + (e?.message || e)));
      return true;
    }
    flash("编辑器不打开相对路径：" + url);
    return false;
  }

  // 点击位置对应的链接地址。活动行会把链接展开成 [文字](地址) 源码，
  // 这时 DOM 上没有 .cm-link，就按语法树把地址找出来。
  function linkHrefAt(pos, targetView = activeView()) {
    const doc = targetView.state.doc;
    for (let n = syntaxTree(targetView.state).resolveInner(pos, 1); n; n = n.parent) {
      if (n.name === "Image") return "";
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

  function bindViewInteractions(targetView, paneName) {
    // 编辑区上下文菜单：按图片、表格、链接和普通文本分别给出可用操作。
    targetView.dom.addEventListener("contextmenu", (e) => {
      focusPane(paneName);
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest(".cm-cell-editor, .cm-image-url")) return;
      if (targetView === getPrimaryView()) {
        const image = target.closest(".cm-image");
        if (image && targetView.dom.contains(image)) {
          showContextMenu(e, imageContextItems(image));
          return;
        }
        const cell = target.closest("td, th");
        const table = target.closest(".cm-table-wrap");
        if (cell && table && targetView.dom.contains(table)) {
          showContextMenu(e, tableContextItems(table, cell));
          return;
        }
      }
      const link = target.closest(".cm-link");
      if (link && targetView.dom.contains(link)) {
        const href = link.dataset.href || "";
        showContextMenu(e, [
          { label: "打开链接", action: () => openLink(href, targetView) },
          { label: "复制链接地址", action: () => copyText(href, "链接地址已复制") },
          { separator: true },
          ...baseEditorContextItems(targetView),
        ]);
        return;
      }
      // 无选区（或右键落在选区之外）时，先将光标移到点击位置再弹菜单
      const clickPos = targetView.posAtCoords({ x: e.clientX, y: e.clientY });
      if (clickPos != null) {
        const main = targetView.state.selection.main;
        const insideSel = !main.empty && clickPos >= main.from && clickPos <= main.to;
        if (!insideSel) {
          targetView.dispatch({ selection: { anchor: clickPos } });
        }
      }
      showContextMenu(e, baseEditorContextItems(targetView));
    });

    // Ctrl / Cmd + 点击正文里的链接
    targetView.contentDOM.addEventListener("mousedown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      const el = e.target instanceof Element ? e.target.closest(".cm-link") : null;
      if (el) {
        e.preventDefault();
        e.stopPropagation();
        openLink(el.dataset.href || "", targetView);
        return;
      }
      const pos = targetView.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return;
      const href = linkHrefAt(pos, targetView);
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      openLink(href, targetView);
    });

    // 点到正文最后一行下面的空白，光标落到最后一行
    targetView.dom.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (
        target.closest(
          ".cm-lang-badge, .cm-fence-copy, .cm-fence-chip, button, a, input, textarea",
        )
      )
        return;
      const last = targetView.contentDOM.lastElementChild;
      if (!last) return;
      const sc = targetView.scrollDOM.getBoundingClientRect();
      if (
        e.clientX < sc.left ||
        e.clientX > sc.right ||
        e.clientY < sc.top ||
        e.clientY > sc.bottom
      )
        return;
      if (e.clientY <= last.getBoundingClientRect().bottom) return;
      e.preventDefault();
      targetView.dispatch({ selection: { anchor: targetView.state.doc.length } });
      targetView.focus();
    });
  }

  return { clearAllTableSelections, bindViewInteractions, imageSourceRange, openLink };
}
