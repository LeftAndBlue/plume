/**
 * 代码块语言选择弹层。
 *
 * Typora 的代码块在右下角用一个小框显示语言名，点一下弹出语言列表，
 * 选完立刻换语法高亮；列表里没有的语言可以「手动输入」——在弹层里直接输入，
 * 不需要让 ``` 围栏显形。
 * 这里对齐这套交互，顺便把常用语言按知名度排好，省得记 ```cpp 还是 ```c++。
 *
 * 不复用 menubar：那个控件绑死在顶栏上（Alt 助记键、左右切菜单、F10），
 * 挂到别处会带进来一堆用不上的行为。
 */
import { canonicalLanguage as canonical } from './code-languages.js';

/** 语言表：value 会原样写进围栏行，必须能匹配 code-languages.js 中的名称或别名 */
const LANGS = [
  ['javascript', 'JavaScript'],
  ['typescript', 'TypeScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['swift', 'Swift'],
  ['kotlin', 'Kotlin'],
  ['sql', 'SQL'],
  ['bash', 'Shell'],
  ['powershell', 'PowerShell'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['scss', 'SCSS'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['xml', 'XML'],
  ['markdown', 'Markdown'],
  ['diff', 'Diff'],
  ['dockerfile', 'Dockerfile'],
];

let pop = null;
let closeCurrent = null;
let manualMode = false;
let manualInput = null;

/** 关掉当前弹层（切文档、失焦、Esc 都要能关） */
function closeLangMenu() {
  if (closeCurrent) closeCurrent();
}

/**
 * @param {HTMLElement} anchor 贴着哪个元素展开（语言标签本身）
 * @param {string} current 当前语言
 * @param {(lang: string, opts: { manual?: boolean }) => void} onPick
 */
export function openLangMenu(anchor, current, onPick) {
  closeLangMenu();

  pop = document.createElement('div');
  pop.className = 'lang-pop';
  pop.setAttribute('role', 'menu');

  // 列表可滚动，底部两条（纯文本 / 手动输入）钉住 —— 它们是「没有我要的语言」时的出口，
  // 不能因为列表滚到哪儿而找不到。
  const list = document.createElement('div');
  list.className = 'lang-list';
  const foot = document.createElement('div');
  foot.className = 'lang-foot';
  pop.append(list, foot);

  const cur = canonical(current);
  const rows = [];
  const values = [];
  const manuals = [];

  const addRow = (parent, value, label, kind) => {
    const row = document.createElement('div');
    row.className = 'lang-row' + (kind === 'manual' ? ' is-manual' : '');
    row.setAttribute('role', 'menuitem');
    row.tabIndex = -1;
    if (value && canonical(value) === cur) row.classList.add('is-current');

    const tick = document.createElement('span');
    tick.className = 'lang-tick';
    tick.textContent = '✓';
    row.appendChild(tick);

    const text = document.createElement('span');
    text.className = 'lang-name';
    text.textContent = label;
    row.appendChild(text);

    if (value) {
      // 右边跟一行等宽的原名：「JavaScript」和要写进围栏的 javascript 不是一回事
      const code = document.createElement('span');
      code.className = 'lang-code';
      code.textContent = value;
      row.appendChild(code);
    }

    row.addEventListener('mousedown', (e) => {
      e.preventDefault(); // 别把焦点从编辑器抢走
      e.stopPropagation();
      pick(value, kind === 'manual');
    });
    row.addEventListener('mouseenter', () => paint(rows.indexOf(row)));

    rows.push(row);
    values.push(value);
    manuals.push(kind === 'manual');
    parent.appendChild(row);
  };

  for (const [value, label] of LANGS) addRow(list, value, label);

  const sep = document.createElement('div');
  sep.className = 'lang-sep';
  foot.appendChild(sep);
  // 纯文本 = 去掉语言标记，不再高亮；手动输入 = 弹层内输入，围栏保持隐藏
  addRow(foot, '', '纯文本', 'plain');
  addRow(foot, '', '手动输入…', 'manual');

  let active = rows.findIndex((r) => r.classList.contains('is-current'));
  const paint = (i) => {
    active = i;
    rows.forEach((r, k) => r.classList.toggle('is-active', k === i));
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
  };

  document.body.appendChild(pop);

  // 先量尺寸再定位：下方装不下就往上翻，右侧超出就往左推
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const below = r.bottom + 4;
  const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  if (active < 0) active = 0;
  paint(active);

  function showManual() {
    manualMode = true;
    pop.replaceChildren();

    const label = document.createElement('label');
    label.className = 'lang-manual-label';
    label.textContent = '语言名称或别名';

    manualInput = document.createElement('input');
    manualInput.className = 'lang-manual-input';
    manualInput.value = current || '';
    manualInput.placeholder = '例如：csharp、mermaid';
    manualInput.spellcheck = false;
    manualInput.setAttribute('aria-label', '语言名称或别名');

    const hint = document.createElement('div');
    hint.className = 'lang-manual-hint';
    hint.textContent = 'Enter 确认 · Esc 取消';
    pop.append(label, manualInput, hint);

    // 定位仍在原标签旁边，但输入框比菜单窄，重新夹一下右边界。
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)))}px`;
    manualInput.focus();
    manualInput.select();
  }

  function commitManual() {
    const value = manualInput ? manualInput.value.trim() : '';
    close();
    onPick(value, { manual: false });
  }

  function pick(value, manual) {
    if (manual) {
      showManual();
      return;
    }
    close();
    onPick(value, { manual: false });
  }

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    closeCurrent = null;
    manualMode = false;
    manualInput = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
  }
  closeCurrent = close;

  function onDocDown(e) {
    if (pop && !pop.contains(e.target)) close();
  }
  function onKey(e) {
    if (!pop) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (manualMode) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        commitManual();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const n = rows.length;
      paint((active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const row = rows[active];
      if (!row) return;
      pick(values[active] || '', !!manuals[active]);
    }
  }

  // 捕获阶段：弹层开着时按键不能漏进编辑器
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  return { close };
}
