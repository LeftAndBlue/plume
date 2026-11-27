/**
 * 右键上下文菜单渲染器（独立自包含模块，从 runtime.js 抽离）。
 */
export function createContextMenu({ flash }) {
  let closeActiveContextMenu = () => {};

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
  const focusablesOf = (menu) =>
    [...menu.querySelectorAll("button:not(:disabled)")].filter((b) => b.offsetParent !== null);
  const keys = (e) => {
    if (!openMenus.length) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const topMenu = openMenus[openMenus.length - 1];
    const btns = focusablesOf(topMenu);
    if (!btns.length) return;
    const activeEl = document.activeElement;
    const idx = btns.indexOf(activeEl);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      btns[(idx + 1 + btns.length) % btns.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      btns[(idx - 1 + btns.length) % btns.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      btns[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      btns[btns.length - 1].focus();
    } else if (e.key === "ArrowRight") {
      if (idx >= 0 && btns[idx]._openSubmenu) {
        e.preventDefault();
        btns[idx]._openSubmenu();
        const subMenu = openMenus[openMenus.length - 1];
        if (subMenu && subMenu !== topMenu) focusablesOf(subMenu)[0]?.focus();
      }
    } else if (e.key === "ArrowLeft" && openMenus.length > 1) {
      e.preventDefault();
      const popped = openMenus.pop();
      const parentAnchor = popped?._parentAnchor;
      popped?.remove();
      parentAnchor?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && idx >= 0) {
      e.preventDefault();
      btns[idx].click();
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
          sub._parentAnchor = btn;
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
        btn._openSubmenu = openSubmenu;

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

  return { showContextMenu, closeActiveContextMenu: () => closeActiveContextMenu() };
}
