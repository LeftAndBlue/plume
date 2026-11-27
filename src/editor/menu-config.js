/**
 * 菜单栏声明、主题菜单页与命令面板条目构造（从 runtime.js 抽离）。
 */
import { ACCEL } from './shortcuts.js';
import { THEMES, getAppearance } from './theme.js';
import { t } from '../i18n.js';

export function buildPaletteCommands() {
  const base = [
    { category: '发布', label: '复制为公众号 / 富文本样式', cmd: 'copy-wechat', keywords: 'wechat 公众号 飞书 邮件 富文本 html' },
    { category: '导出', label: '导出为 PDF', cmd: 'export-pdf', accel: ACCEL['export-pdf'], keywords: 'pdf print 导出' },
    { category: '导出', label: '导出为 HTML（含样式）', cmd: 'export-html', keywords: 'html export' },
    { category: '导出', label: '导出为 Word (.docx)', cmd: 'export-docx', keywords: 'word docx' },
    { category: '导出', label: '导出为长图 PNG', cmd: 'export-png', keywords: 'png image 长图' },
    { category: '排版', label: '中英文自动加空格', cmd: 'format-spacing', keywords: 'pangu spacing 空格 盘古' },
    { category: '视图', label: '切换专注模式', cmd: 'focus', accel: ACCEL.focus, keywords: 'focus 专注' },
    { category: '视图', label: '切换打字机模式', cmd: 'typewriter', accel: ACCEL.typewriter, keywords: 'typewriter 打字机' },
    { category: '视图', label: '切换源代码模式', cmd: 'source-mode', accel: ACCEL['source-mode'], keywords: 'source 源码' },
    { category: '视图', label: '放大正文字号', cmd: 'zoom-in', accel: ACCEL['zoom-in'], keywords: 'font zoom 放大 字号' },
    { category: '视图', label: '缩小正文字号', cmd: 'zoom-out', accel: ACCEL['zoom-out'], keywords: 'font zoom 缩小 字号' },
    { category: '视图', label: '重置正文字号', cmd: 'zoom-reset', accel: ACCEL['zoom-reset'], keywords: 'font zoom 重置 字号' },
    { category: '导航', label: '返回上一处光标位置', cmd: 'jump-back', accel: ACCEL['jump-back'], keywords: 'back jump 后退 光标' },
    { category: '导航', label: '前进到下一处光标位置', cmd: 'jump-forward', accel: ACCEL['jump-forward'], keywords: 'forward jump 前进 光标' },
    { category: '大纲', label: '折叠当前章节（H1–H3）', cmd: 'fold-heading', accel: ACCEL['fold-heading'], keywords: 'fold 折叠 标题' },
    { category: '大纲', label: '展开当前章节（H1–H3）', cmd: 'unfold-heading', accel: ACCEL['unfold-heading'], keywords: 'unfold 展开 标题' },
    { category: '大纲', label: '折叠全部标题章节', cmd: 'fold-all-headings', keywords: 'fold all 全部折叠' },
    { category: '大纲', label: '展开全部标题章节', cmd: 'unfold-all-headings', keywords: 'unfold all 全部展开' },
    { category: '文件', label: t('menu.openFolder'), cmd: 'open-folder', keywords: 'folder workspace 打开文件夹 目录' },
    { category: '文件', label: '恢复未保存草稿', cmd: 'draft-recovery', keywords: 'draft recovery 草稿 恢复' },
    { category: '文件', label: '跨文件搜索与替换', cmd: 'search-files', accel: ACCEL['search-files'], keywords: 'search replace 搜索' },
    { category: '设置', label: '打开外观与编辑器设置', cmd: 'settings', keywords: 'settings preferences 设置' },
    { category: '设置', label: '打开主题商店', cmd: 'theme-store', keywords: 'theme store 主题' },
    { category: '帮助', label: '查看快捷键一览', cmd: 'shortcuts', accel: ACCEL.shortcuts, keywords: 'shortcuts keymap 快捷键' },
  ];
  const themeCmds = THEMES.map((th) => ({
    category: '主题',
    label: `切换主题：${th.label}`,
    cmd: `theme:${th.id}`,
    keywords: `theme 主题 ${th.id} ${th.label}`,
  }));
  return [...base, ...themeCmds];
}

export function renderThemeMenuPage(host, { run, close }) {
  const prefs = getAppearance();
  const form = document.createElement('div');
  form.className = 'menu-form';

  const selectRow = (label, options, current, onPick) => {
    const row = document.createElement('label');
    row.className = 'menu-form-row';
    const text = document.createElement('span');
    text.textContent = label;
    const select = document.createElement('select');
    for (const [value, name] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = name;
      if (String(value) === String(current)) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => onPick(select.value));
    row.append(text, select);
    form.appendChild(row);
  };

  const checkRow = (label, checked, onToggle) => {
    const row = document.createElement('label');
    row.className = 'menu-form-row';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    input.addEventListener('change', onToggle);
    row.append(text, input);
    form.appendChild(row);
  };

  selectRow(t('settings.theme'), THEMES.map((th) => [th.id, th.label]), prefs.theme, (v) => run(`theme:${v}`));
  selectRow(
    t('settings.density'),
    [
      ['compact', t('settings.density.compact')],
      ['comfortable', t('settings.density.comfortable')],
      ['loose', t('settings.density.loose')],
    ],
    prefs.density,
    (v) => run(`appearance:density:${v}`),
  );
  const widths = [
    ['narrow', t('themeMenu.width.narrow')],
    ['standard', t('themeMenu.width.standard')],
    ['wide', t('themeMenu.width.wide')],
    ['full', t('themeMenu.width.full')],
  ];
  if (!widths.some(([v]) => v === prefs.pageWidth)) widths.push([prefs.pageWidth, t('themeMenu.width.custom')]);
  selectRow(t('themeMenu.width'), widths, prefs.pageWidth, (v) => run(`appearance:width:${v}`));
  selectRow(
    t('settings.fontSize'),
    Array.from({ length: 17 }, (_, i) => {
      const n = 12 + i;
      return [n, `${n} px`];
    }),
    prefs.fontSize,
    (v) => run(`appearance:size:${v}`),
  );
  const fonts = [
    ['theme', t('settings.fontStyle.theme')],
    ['sans', t('settings.fontStyle.sans')],
    ['serif', t('settings.fontStyle.serif')],
  ];
  if (prefs.fontStyle === 'custom') fonts.push(['custom', t('settings.fontStyle.custom')]);
  selectRow(t('settings.fontStyle'), fonts, prefs.fontStyle, (v) => run(`appearance:font:${v}`));
  checkRow(t('settings.firstLineIndent'), prefs.firstLineIndent, () => run('appearance:indent'));
  checkRow(t('settings.codeLineNumbers'), prefs.codeLineNumbers, () => run('appearance:code-ln'));

  const actions = document.createElement('div');
  actions.className = 'menu-form-actions';
  for (const [label, cmd] of [
    [t('themeMenu.themeStore'), 'theme-store'],
    [t('themeMenu.themeFolder'), 'theme-folder'],
  ]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      close();
      run(cmd);
    });
    actions.appendChild(btn);
  }
  form.appendChild(actions);
  host.appendChild(form);
}

export function createMenus({ readRecent, sidebarVisible, sideView, shell, isSourceMode, state }) {
  return [
    {
      id: 'file',
      get label() { return t('menu.file'); },
      mnemonic: 'F',
      items: () => {
        const recent = readRecent().map((p, i) => ({
          label: p.split(/[\\/]/).pop(),
          cmd: 'recent:' + i,
        }));
        return [
          { label: t('menu.new'), cmd: 'new', accel: ACCEL.new },
          { label: t('menu.open'), cmd: 'open', accel: ACCEL.open },
          { label: t('menu.openFolder'), cmd: 'open-folder' },
          { label: t('menu.quickOpen'), cmd: 'quick-open', accel: ACCEL['quick-open'] },
          ...(recent.length ? [{ type: 'sep' }, ...recent] : []),
          { type: 'sep' },
          { label: t('menu.save'), cmd: 'save', accel: ACCEL.save },
          { label: t('menu.saveAs'), cmd: 'save-as', accel: ACCEL['save-as'] },
          { label: t('menu.draftRecovery'), cmd: 'draft-recovery' },
          { type: 'sep' },
          {
            label: t('menu.export'),
            submenu: () => [
              { label: t('menu.copyWechat'), cmd: 'copy-wechat' },
              { type: 'sep' },
              { label: t('menu.exportHtml'), cmd: 'export-html' },
              { label: t('menu.exportHtmlBare'), cmd: 'export-html-bare' },
              { type: 'sep' },
              { label: t('menu.exportDocx'), cmd: 'export-docx' },
              { label: t('menu.exportRtf'), cmd: 'export-rtf' },
              { label: t('menu.exportEpub'), cmd: 'export-epub' },
              { label: t('menu.exportLatex'), cmd: 'export-latex' },
              { label: t('menu.exportPng'), cmd: 'export-png' },
              { label: t('menu.exportPdf'), cmd: 'export-pdf', accel: ACCEL['export-pdf'] },
            ],
          },
          { type: 'sep' },
          { label: t('menu.closeWindow'), cmd: 'close-window' },
        ];
      },
    },
    {
      id: 'view',
      get label() { return t('menu.view'); },
      mnemonic: 'V',
      items: () => [
        {
          label: t('menu.fileTree'),
          cmd: 'view-files',
          accel: ACCEL['view-files'],
          checked: () => sidebarVisible() && sideView() === 'files',
        },
        {
          label: t('menu.outline'),
          cmd: 'view-outline',
          accel: ACCEL['view-outline'],
          checked: () => sidebarVisible() && sideView() === 'outline',
        },
        { type: 'sep' },
        { label: t('menu.searchFiles'), cmd: 'search-files', accel: ACCEL['search-files'] },
        { label: t('menu.foldHeading'), cmd: 'fold-heading', accel: ACCEL['fold-heading'] },
        { label: t('menu.unfoldHeading'), cmd: 'unfold-heading', accel: ACCEL['unfold-heading'] },
        { label: t('menu.foldAllHeadings'), cmd: 'fold-all-headings' },
        { label: t('menu.unfoldAllHeadings'), cmd: 'unfold-all-headings' },
        {
          label: t('menu.showSidebar'),
          cmd: 'toggle-sidebar',
          checked: () => sidebarVisible(),
        },
        {
          label: t('menu.showTabs'),
          cmd: 'toggle-tabs',
          checked: () => shell.tabsVisible,
        },
        { type: 'sep' },
        {
          label: t('menu.sourceMode'),
          cmd: 'source-mode',
          accel: ACCEL['source-mode'],
          checked: isSourceMode,
        },
        {
          label: t('menu.focusMode'),
          cmd: 'focus',
          accel: ACCEL.focus,
          checked: () => document.body.classList.contains('focus-mode'),
        },
        {
          label: t('menu.typewriter'),
          cmd: 'typewriter',
          accel: ACCEL.typewriter,
          checked: () => state.typewriter,
        },
        { type: 'sep' },
        {
          label: t('menu.spellcheck'),
          cmd: 'appearance:spell',
          checked: () => getAppearance().spellcheck,
        },
        { label: t('menu.settings'), cmd: 'settings' },
      ],
    },
    {
      id: 'image',
      get label() { return t('menu.images'); },
      mnemonic: 'I',
      items: () => [
        { label: t('menu.insertImage'), cmd: 'image' },
        { type: 'sep' },
        { label: t('menu.uploadImages'), cmd: 'upload-document-images' },
        { type: 'sep' },
        { label: t('menu.imageSettings'), cmd: 'image-settings' },
      ],
    },
    {
      id: 'theme',
      get label() { return t('menu.theme'); },
      mnemonic: 'T',
      render: renderThemeMenuPage,
    },
    {
      id: 'help',
      get label() { return t('menu.help'); },
      mnemonic: 'H',
      items: () => [
        { label: t('menu.shortcuts'), cmd: 'shortcuts', accel: ACCEL.shortcuts },
        { label: t('menu.checkUpdate'), cmd: 'check-update' },
        { label: t('menu.settings'), cmd: 'settings' },
        { label: t('menu.license'), cmd: 'license' },
        { label: t('menu.about'), cmd: 'about' },
      ],
    },
  ];
}
