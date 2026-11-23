/**
 * 插入表格时的「几行几列」选择器。
 *
 * 交互照 Typora：悬停网格直接看出要插多大的表，点一下就插入；
 * 同时给两个数字输入框，网格放不下的尺寸也能精确指定。
 * 这里只管 UI 和取值，不碰编辑器状态——结果通过 onPick 交回调用方。
 */
import { t } from "../i18n.js";

/* 网格第 (c, r) 格代表 (c + MIN_COLS) 列 × (r + MIN_ROWS) 行。
 * Markdown 表格必须有一行表头，且本项目的扫描器要求至少 2 列，
 * 所以两项都从 2 起：网格左上角就是最小的合法表格。 */
const GRID_COLS = 9;
const GRID_ROWS = 7;
const MIN_COLS = 2;
const MIN_ROWS = 2; // 总行数，含 1 行表头
const MAX_COLS = 20;
const MAX_ROWS = 30;

let closeActive = null;

const clamp = (value, lo, hi) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};

export function openTablePicker({ anchor, initial, onPick, onClose } = {}) {
  if (closeActive) closeActive();

  let cols = clamp(initial?.cols ?? 3, MIN_COLS, MAX_COLS);
  let rows = clamp(initial?.rows ?? 2, MIN_ROWS, MAX_ROWS);
  let finished = false;

  const root = document.createElement("div");
  root.className = "table-picker";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", t("tablePicker.title"));
  root.tabIndex = -1;
  root.innerHTML = `
    <div class="tp-title"></div>
    <div class="tp-grid" role="grid"></div>
    <div class="tp-readout"><b></b><span></span></div>
    <div class="tp-fields">
      <label><span class="tp-label-cols"></span><input class="tp-cols" type="number" min="${MIN_COLS}" max="${MAX_COLS}" step="1" inputmode="numeric"></label>
      <label><span class="tp-label-rows"></span><input class="tp-rows" type="number" min="${MIN_ROWS}" max="${MAX_ROWS}" step="1" inputmode="numeric"></label>
    </div>
    <div class="tp-actions">
      <button type="button" class="tp-cancel"></button>
      <button type="button" class="tp-insert tp-primary"></button>
    </div>`;

  root.querySelector(".tp-title").textContent = t("tablePicker.title");
  root.querySelector(".tp-readout span").textContent = t("tablePicker.hint");
  root.querySelector(".tp-label-cols").textContent = t("tablePicker.cols");
  root.querySelector(".tp-label-rows").textContent = t("tablePicker.rows");
  root.querySelector(".tp-cancel").textContent = t("tablePicker.cancel");
  const insertBtn = root.querySelector(".tp-insert");
  insertBtn.textContent = t("tablePicker.insert");

  const readout = root.querySelector(".tp-readout b");
  const colsInput = root.querySelector(".tp-cols");
  const rowsInput = root.querySelector(".tp-rows");
  const grid = root.querySelector(".tp-grid");
  grid.style.gridTemplateColumns = `repeat(${GRID_COLS}, minmax(0, 1fr))`;

  const cells = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const nc = c + MIN_COLS;
      const nr = r + MIN_ROWS;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "tp-cell";
      cell.dataset.cols = String(nc);
      cell.dataset.rows = String(nr);
      cell.setAttribute("aria-label", t("tablePicker.readout", { cols: nc, rows: nr }));
      cell.addEventListener("mouseenter", () => setSelection(nc, nr));
      cell.addEventListener("click", () => {
        // click 前再同步一次：commit 以输入框为准，悬停没触发时（触屏 / 快速点击）也能拿到正确值
        setSelection(nc, nr);
        commit();
      });
      grid.appendChild(cell);
      cells.push(cell);
    }
  }

  function setSelection(nextCols, nextRows, syncInputs = true) {
    cols = clamp(nextCols, MIN_COLS, MAX_COLS);
    rows = clamp(nextRows, MIN_ROWS, MAX_ROWS);
    readout.textContent = t("tablePicker.readout", { cols, rows });
    if (syncInputs) {
      colsInput.value = String(cols);
      rowsInput.value = String(rows);
    }
    for (const cell of cells) {
      cell.classList.toggle(
        "is-on",
        Number(cell.dataset.cols) <= cols && Number(cell.dataset.rows) <= rows,
      );
    }
  }

  const dispose = () => {
    if (finished) return;
    finished = true;
    root.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", dispose);
    if (closeActive === dispose) closeActive = null;
    onClose?.();
  };

  function commit() {
    if (finished) return;
    // 以输入框为准：手填的数字可能在网格范围之外，也要生效
    cols = clamp(colsInput.value, MIN_COLS, MAX_COLS);
    rows = clamp(rowsInput.value, MIN_ROWS, MAX_ROWS);
    const picked = { cols, rows };
    dispose();
    try {
      onPick?.(picked);
    } catch (err) {
      console.error("插入表格失败", err);
    }
  }

  const outside = (e) => {
    if (!root.contains(e.target)) dispose();
  };

  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
      return;
    }
    if (e.target instanceof HTMLInputElement) return;
    let dc = 0;
    let dr = 0;
    if (e.key === "ArrowLeft") dc = -1;
    else if (e.key === "ArrowRight") dc = 1;
    else if (e.key === "ArrowUp") dr = -1;
    else if (e.key === "ArrowDown") dr = 1;
    else return;
    e.preventDefault();
    setSelection(cols + dc, rows + dr);
  };

  const onInput = () => setSelection(colsInput.value, rowsInput.value, false);
  const normalize = () => {
    colsInput.value = String(cols);
    rowsInput.value = String(rows);
  };
  colsInput.addEventListener("input", onInput);
  rowsInput.addEventListener("input", onInput);
  colsInput.addEventListener("change", normalize);
  rowsInput.addEventListener("change", normalize);
  root.querySelector(".tp-cancel").addEventListener("click", dispose);
  insertBtn.addEventListener("click", commit);

  document.body.appendChild(root);
  setSelection(cols, rows);

  // 贴着光标下方弹出；靠边时自动收回视口内
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  const ax = Number.isFinite(anchor?.x) ? anchor.x : window.innerWidth / 2;
  const ay = Number.isFinite(anchor?.y) ? anchor.y : window.innerHeight / 2;
  root.style.left = `${Math.max(8, Math.min(ax, window.innerWidth - w - 8))}px`;
  root.style.top = `${Math.max(8, Math.min(ay + 8, window.innerHeight - h - 8))}px`;

  closeActive = dispose;
  // 延后一拍再挂外部点击：避免「打开选择器」的那次点击立刻把自己关掉
  setTimeout(() => {
    if (finished) return;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", dispose);
    root.focus({ preventScroll: true });
  }, 0);

  return dispose;
}
