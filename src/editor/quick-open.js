/**
 * 快速打开与命令面板（Ctrl+Shift+P）：
 * - 普通输入：在当前文档所在目录内按文件名 / 内容搜索并打开
 * - 以 `>` 开头：切换为命令面板，直接搜索并执行编辑器命令（切主题、导出 PDF、公众号复制、中英文加空格、专注模式等）
 */
import { t } from "../i18n.js";

import { filterPaletteCommands } from "./extrasText.js";
export { filterPaletteCommands };

export function createQuickOpen({
  state,
  openSheet,
  flash,
  openFile,
  settleCurrentDocument,
  openDiskDoc,
  samePath,
  getCommands = () => [],
  runCommand = () => {},
}) {
  return function quickOpen({ initialValue = "" } = {}) {
    const root = state.dir;
    const hasFileSearch = !!(window.studio && root);
    const startValue = initialValue || (hasFileSearch ? "" : "> ");

    openSheet(t("quick.title"), (body, close) => {
      const wrap = document.createElement("div");
      wrap.className = "quick-open";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "quick-open-input";
      input.value = startValue;
      input.placeholder = hasFileSearch
        ? "输入文件名/正文搜索，或输入 > 搜索命令…"
        : "输入 > 搜索命令（切主题、导出、排版、专注模式…）";
      input.setAttribute("aria-label", t("quick.aria"));
      const list = document.createElement("div");
      list.className = "quick-open-list";
      list.setAttribute("role", "listbox");
      const hint = document.createElement("div");
      hint.className = "quick-open-hint";
      hint.textContent = "↑/↓ 选择 · Enter 执行 · 输入 > 切换命令面板 · Esc 关闭";
      wrap.append(input, list, hint);
      body.appendChild(wrap);

      let items = [];
      let mode = "file"; // 'file' | 'command'
      let sel = 0;
      let seq = 0;
      let timer = 0;

      const isCommandMode = () => input.value.trimStart().startsWith(">");

      const render = () => {
        list.replaceChildren();
        items.forEach((it, i) => {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "quick-open-item" + (i === sel ? " is-sel" : "");
          row.setAttribute("role", "option");
          row.setAttribute("aria-selected", i === sel ? "true" : "false");
          const name = document.createElement("span");
          name.className = "quick-open-name";
          const sub = document.createElement("span");
          sub.className = "quick-open-sub";
          if (mode === "command") {
            name.textContent = it.category ? `${it.category} · ${it.label}` : it.label;
            sub.textContent = it.accel || it.cmd || "";
          } else {
            name.textContent = it.name;
            sub.textContent = it.line ? t("quick.lineSub", { n: it.line, text: it.text }) : it.dir;
          }
          row.append(name, sub);
          row.addEventListener("mousedown", (e) => e.preventDefault());
          row.addEventListener("click", () => activate(it));
          list.appendChild(row);
        });
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "quick-open-empty";
          if (mode === "command") {
            empty.textContent = "没有匹配的命令";
          } else if (!hasFileSearch) {
            empty.textContent = "当前未打开磁盘目录；输入 > 可直接搜索并执行命令";
          } else {
            empty.textContent = input.value.trim() ? t("quick.noMatch") : t("quick.empty");
          }
          list.appendChild(empty);
        }
        list.children[sel]?.scrollIntoView({ block: "nearest" });
      };

      const activate = async (item) => {
        if (!item) return;
        if (mode === "command") {
          close();
          if (typeof item.action === "function") item.action();
          else if (item.cmd) runCommand(item.cmd);
          return;
        }
        close();
        if (samePath(item.path, state.path)) return;
        if (!(await settleCurrentDocument())) return;
        try {
          const r = await window.studio.readFile(item.path);
          openDiskDoc(r);
        } catch (err) {
          flash("打开失败：" + (err && err.message ? err.message : err));
        }
      };

      const search = async () => {
        if (isCommandMode()) {
          mode = "command";
          seq++;
          items = filterPaletteCommands(getCommands(), input.value).slice(0, 60);
          sel = 0;
          render();
          return;
        }
        mode = "file";
        const q = input.value.trim();
        const my = ++seq;
        if (!q || !hasFileSearch) {
          items = [];
          sel = 0;
          render();
          return;
        }
        try {
          const outcome = await window.studio.searchFiles(root, q);
          if (my !== seq) return;
          const hits = outcome.hits || [];
          const byPath = new Map();
          for (const h of hits) {
            const prev = byPath.get(h.path);
            if (!prev || (prev.line && !h.line)) byPath.set(h.path, h);
          }
          items = [...byPath.values()].slice(0, 50).map((h) => ({
            ...h,
            dir: h.path.slice(0, Math.max(0, h.path.length - h.name.length)).replace(/[\\/]+$/, ""),
          }));
          sel = 0;
          render();
        } catch {
          /* 搜索失败保留旧结果 */
        }
      };

      input.addEventListener("input", () => {
        clearTimeout(timer);
        if (isCommandMode()) {
          search();
        } else {
          timer = setTimeout(search, 160);
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          sel = Math.min(sel + 1, Math.max(0, items.length - 1));
          render();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          sel = Math.max(sel - 1, 0);
          render();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (items[sel]) activate(items[sel]);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      search();
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    });
  };
}