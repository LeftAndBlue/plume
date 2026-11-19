/**
 * 快速打开（Ctrl+Shift+P）：在当前文档所在目录内按文件名 / 内容搜索并打开。
 * 从 runtime.js 抽离；依赖通过工厂注入。
 */
import { t } from "../i18n.js";

export function createQuickOpen({
  state,
  openSheet,
  flash,
  openFile,
  settleCurrentDocument,
  openDiskDoc,
  samePath,
}) {
  return function quickOpen() {
    if (!window.studio) {
      openFile();
      return;
    }
    const root = state.dir;
    if (!root) {
      flash("先打开一个文件，才能在其目录内快速打开");
      openFile();
      return;
    }
    openSheet(t("quick.title"), (body, close) => {
      const wrap = document.createElement("div");
      wrap.className = "quick-open";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "quick-open-input";
      input.placeholder = t("quick.placeholder");
      input.setAttribute("aria-label", t("quick.aria"));
      const list = document.createElement("div");
      list.className = "quick-open-list";
      list.setAttribute("role", "listbox");
      const hint = document.createElement("div");
      hint.className = "quick-open-hint";
      hint.textContent = t("quick.hint");
      wrap.append(input, list, hint);
      body.appendChild(wrap);

      let items = [];
      let sel = 0;
      let seq = 0;
      let timer = 0;

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
          name.textContent = it.name;
          const sub = document.createElement("span");
          sub.className = "quick-open-sub";
          sub.textContent = it.line ? t("quick.lineSub", { n: it.line, text: it.text }) : it.dir;
          row.append(name, sub);
          row.addEventListener("mousedown", (e) => e.preventDefault());
          row.addEventListener("click", () => open(it.path));
          list.appendChild(row);
        });
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "quick-open-empty";
          empty.textContent = input.value.trim() ? t("quick.noMatch") : t("quick.empty");
          list.appendChild(empty);
        }
        list.children[sel]?.scrollIntoView({ block: "nearest" });
      };

      const open = async (p) => {
        close();
        if (samePath(p, state.path)) return;
        if (!(await settleCurrentDocument())) return;
        try {
          const r = await window.studio.readFile(p);
          openDiskDoc(r);
        } catch (err) {
          flash("打开失败：" + (err && err.message ? err.message : err));
        }
      };

      const search = async () => {
        const q = input.value.trim();
        const my = ++seq;
        if (!q) {
          items = [];
          sel = 0;
          render();
          return;
        }
        try {
          const outcome = await window.studio.searchFiles(root, q);
          if (my !== seq) return; // 丢弃过期结果
          const hits = outcome.hits || [];
          // 每个文件只留一条：文件名命中优先于内容命中
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
        timer = setTimeout(search, 160);
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
          if (items[sel]) open(items[sel].path);
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      render();
      requestAnimationFrame(() => input.focus());
    });
  };
}