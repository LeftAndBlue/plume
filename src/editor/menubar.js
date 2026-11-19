/**
 * 菜单栏控件：把一份声明式菜单描述渲染成「原生菜单栏」的样子和手感。
 *
 * 为什么不用 Electron 的 Menu：Windows 下 `titleBarStyle: 'hidden'` 时原生菜单栏
 * 根本不会渲染（Window 的客户区顶到窗口边缘，menuBarVisible === false）。
 * 原生菜单栏和「深色可跟随的自绘窗口外壳」只能二选一，所以这里自己画一条，
 * 但把原生的交互习惯补齐：Alt 助记键、左右切菜单、上下选条目、Esc 关闭、
 * 加速键文本右对齐、勾选/禁用态。
 *
 * 菜单描述：
 *   { id, label, mnemonic: 'F', items: [
 *       { type: 'sep' }
 *       { label, cmd, accel, checked?: () => bool, disabled?: () => bool }
 *   ] }
 */

export function createMenubar({ bar, pop, menus, run }) {
  let openId = null; // 当前展开的菜单 id
  let activeIndex = -1; // 展开时键盘高亮的条目序号
  let altDown = false;

  const byId = (id) => menus.find((m) => m.id === id);

  /* ---------------- 顶栏按钮 + Typora 式菜单页 ---------------- */

  const toggle = document.getElementById('menu-toggle');
  if (toggle && !toggle.querySelector('.menu-bars')) {
    const bars = document.createElement('span');
    bars.className = 'menu-bars';
    bars.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) bars.appendChild(document.createElement('i'));
    toggle.appendChild(bars);
  }
  const panel = document.createElement('div');
  panel.id = 'menu-panel';
  panel.hidden = true;

  const side = document.createElement('aside');
  side.className = 'menu-side';

  for (const menu of menus) {
    const btn = document.createElement('button');
    btn.className = 'mb-item';
    btn.type = 'button';
    btn.dataset.menu = menu.id;
    btn.setAttribute('role', 'menuitem');
    btn.tabIndex = -1;

    const label = document.createElement('span');
    label.textContent = menu.label;
    btn.appendChild(label);
    if (menu.mnemonic) {
      const m = document.createElement('span');
      m.className = 'mb-mnemonic';
      m.textContent = `(${menu.mnemonic})`;
      btn.appendChild(m);
    }

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(menu.id);
    });
    side.appendChild(btn);
  }

  const stage = document.createElement('div');
  stage.className = 'menu-stage';
  const stageTitle = document.createElement('h2');
  stageTitle.className = 'menu-stage-title';
  stage.appendChild(stageTitle);
  stage.appendChild(pop);
  panel.append(side, stage);
  document.body.appendChild(panel);

  toggle?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openId) close({ restoreFocus: true });
    else openMenu(menus[0].id);
  });

  /* ---------------- 右侧命令列表 ---------------- */

  function render(menu) {
    pop.replaceChildren();
    stageTitle.textContent = menu.label;
    // 自定义页（如主题页的表单）：由菜单自己渲染内容，不走命令列表。
    // 此时没有可高亮的命令行，键盘导航也让位给表单控件（见 keydown）。
    if (typeof menu.render === 'function') {
      currentItems = [];
      menu.render(pop, {
        run: (cmd) => run(cmd),
        close: () => close({ restoreFocus: true }),
      });
      return [];
    }
    const rows = [];
    const items = []; // 和 rows 一一对应，KeyboardEvent 里按下标取回原始条目
    const list = typeof menu.items === 'function' ? menu.items() : menu.items;
    for (const it of list) {
      if (it.type === 'sep') {
        const sep = document.createElement('div');
        sep.className = 'menu-sep';
        sep.setAttribute('role', 'separator');
        pop.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'menu-item';
      row.setAttribute('role', it.radio ? 'menuitemradio' : 'menuitem');
      row.tabIndex = -1;

      const disabled = !!(it.disabled && it.disabled());
      if (disabled) row.classList.add('is-disabled');

      const mark = document.createElement('span');
      mark.className = 'menu-mark';
      mark.textContent = it.checked && it.checked() ? (it.radio ? '●' : '✓') : '';
      row.appendChild(mark);

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = it.label;
      row.appendChild(label);

      if (it.accel) {
        const accel = document.createElement('span');
        accel.className = 'menu-accel';
        accel.textContent = it.accel;
        row.appendChild(accel);
      }

      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (disabled) return;
        fire(it);
      });
      row.addEventListener('mouseenter', () => {
        activeIndex = rows.indexOf(row);
        paintActive();
      });

      rows.push(row);
      items.push(it);
      pop.appendChild(row);
    }
    currentItems = items;
    return rows;
  }

  let currentRows = [];
  let currentItems = [];

  function paintActive() {
    currentRows.forEach((r, i) => r.classList.toggle('is-active', i === activeIndex));
  }

  function fire(item) {
    close({ restoreFocus: true });
    run(item.cmd, item);
  }

  function openMenu(id, { focusFirst = false } = {}) {
    const menu = byId(id);
    if (!menu) return;
    const btn = side.querySelector(`.mb-item[data-menu="${id}"]`);
    if (!btn) return;

    openId = id;
    for (const b of side.querySelectorAll('.mb-item')) b.classList.toggle('is-open', b.dataset.menu === id);
    currentRows = render(menu);
    clearTimeout(closeTimer);
    panel.hidden = false;
    pop.hidden = false;
    panel.classList.remove('is-open');
    document.body.classList.add('menu-open');
    requestAnimationFrame(() => panel.classList.add('is-open'));
    pop.style.left = '';
    pop.style.top = '';
    pop.dataset.menu = menu.id;
    activeIndex = focusFirst ? firstEnabled() : -1;
    paintActive();
  }

  let closeTimer = 0;

  function close({ restoreFocus = false } = {}) {
    if (!openId && panel.hidden) return;
    openId = null;
    activeIndex = -1;
    panel.classList.remove('is-open');
    document.body.classList.remove('menu-open');
    for (const b of side.querySelectorAll('.mb-item')) b.classList.remove('is-open');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      pop.hidden = true;
      panel.hidden = true;
      pop.replaceChildren();
    }, 280);
    if (restoreFocus) document.dispatchEvent(new CustomEvent('menubar:closed'));
  }

  const firstEnabled = () => currentRows.findIndex((r) => !r.classList.contains('is-disabled'));

  function step(delta) {
    const n = currentRows.length;
    if (!n) return;
    let i = activeIndex;
    for (let k = 0; k < n; k++) {
      i = (i + delta + n) % n;
      if (!currentRows[i].classList.contains('is-disabled')) break;
    }
    activeIndex = i;
    paintActive();
  }

  function switchMenu(delta) {
    const i = menus.findIndex((m) => m.id === openId);
    if (i < 0) return;
    const next = menus[(i + delta + menus.length) % menus.length];
    openMenu(next.id, { focusFirst: true });
  }

  /* ---------------- 键盘 ---------------- */

  // 捕获阶段处理：菜单开着时不能让按键漏进编辑器
  document.addEventListener(
    'keydown',
    (e) => {
      // Alt 助记键：按住 Alt 时给字母加下划线
      if (e.key === 'Alt' && !altDown) {
        altDown = true;
        document.body.classList.add('alt-mode');
        return;
      }

      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const upper = e.key.toUpperCase();
        const menu = menus.find((m) => m.mnemonic === upper);
        if (menu) {
          e.preventDefault();
          e.stopPropagation();
          if (openId === menu.id) close();
          else openMenu(menu.id, { focusFirst: true });
          return;
        }
      }

      if (!openId) {
        // 没开菜单时，F10 / Alt 单独按聚焦菜单栏（原生行为）
        if (e.key === 'F10') {
          e.preventDefault();
          openMenu(menus[0].id, { focusFirst: true });
        }
        return;
      }

      const key = e.key;
      if (key === 'Escape' || key === 'F10') {
        e.preventDefault();
        e.stopPropagation();
        close({ restoreFocus: true });
        return;
      }
      // 自定义表单页：方向键 / 回车 / 空格等留给 select、checkbox 自己处理，
      // 否则下拉框没法用键盘展开和选择。
      if (typeof byId(openId)?.render === 'function') return;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        switchMenu(key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        step(key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (key === 'Home' || key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        activeIndex = key === 'Home' ? firstEnabled() : currentRows.length - 1;
        paintActive();
        return;
      }
      if (key === 'Enter' || key === ' ') {
        const row = currentRows[activeIndex];
        if (row && !row.classList.contains('is-disabled')) {
          e.preventDefault();
          e.stopPropagation();
          const item = currentItems[activeIndex];
          if (item) fire(item);
        }
        return;
      }
    },
    true
  );

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altDown = false;
      document.body.classList.remove('alt-mode');
    }
  });

  // 点空白处关掉；窗口失焦也关掉（原生菜单同样会收起）
  document.addEventListener('mousedown', (e) => {
    if (!openId) return;
    if (panel.contains(e.target) || toggle?.contains(e.target)) return;
    close();
  });
  window.addEventListener('blur', () => {
    // Alt+Tab 出去时 keyup 收不到，别让下划线一直挂着
    altDown = false;
    document.body.classList.remove('alt-mode');
    close();
  });
  window.addEventListener('resize', () => close());

  return {
    open: openMenu,
    close,
    isOpen: () => !!openId,
    /** 菜单项被点掉后要重新读一次勾选态：下次展开时重渲染即可，这里只是语义占位 */
    refresh: () => {
      if (openId) openMenu(openId);
    },
    /** 语言切换后重读顶栏按钮文案（menu.label 可以是 getter）；开着的菜单页整体重渲染 */
    refreshLabels: () => {
      for (const menu of menus) {
        const btn = side.querySelector(`.mb-item[data-menu="${menu.id}"]`);
        const span = btn?.querySelector('span');
        if (span) span.textContent = menu.label;
      }
      if (openId) openMenu(openId);
    },
  };
}
