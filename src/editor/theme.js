import { refreshDecorations } from './live-preview.js';

export const THEMES = [
  { id: 'white', label: 'White（浅色）', dark: false, swatch: ['#ffffff', '#2563eb', '#24292f'] },
  { id: 'sepia', label: 'Sepia（羊皮纸）', dark: false, swatch: ['#f6f0e6', '#8a5a2b', '#3e3426'] },
  { id: 'vue', label: 'Vue（翠竹）', dark: false, swatch: ['#ffffff', '#42b883', '#2c3e50'] },
  { id: 'night', label: 'Night（深色）', dark: true, swatch: ['#1c2028', '#58a6ff', '#d4d7dd'] },
  { id: 'github', label: 'GitHub', dark: false, swatch: ['#ffffff', '#0969da', '#1f2328'] },
  { id: 'newsprint', label: 'Newsprint（报纸）', dark: false, swatch: ['#f4ecd8', '#8a5a2b', '#3e3426'] },
  { id: 'pixyll', label: 'Pixyll', dark: false, swatch: ['#ffffff', '#0074d9', '#333333'] },
  { id: 'gothic', label: 'Gothic（哥特）', dark: true, swatch: ['#0e0e0e', '#d8d8d8', '#ececec'] },
];

const LEGACY_KEY = 'mdstudio.theme';
const STORAGE_KEY = 'markline.appearance.v1';

const DEFAULT_PREFS = {
  theme: 'white',
  fontStyle: 'theme',
  fontFamily: '',
  fontSize: 16,
  density: 'comfortable',
  lineHeight: 1.75,
  paraEm: 0.8,
  blockPx: 14,
  pageWidth: 'standard',
  contentPx: 800,
  codePx: 0,
  firstLineIndent: false,
  codeLineNumbers: true,
  spellcheck: false,
};

const DENSITY_MAP = {
  compact: { lineHeight: '1.62', paraSpacing: '0.45em', blockGap: '8px' },
  comfortable: { lineHeight: '1.75', paraSpacing: '0.8em', blockGap: '14px' },
  loose: { lineHeight: '1.9', paraSpacing: '1.15em', blockGap: '20px' },
};

const WIDTH_MAP = {
  narrow: '720px',
  standard: '800px',
  wide: '960px',
  full: '100%',
};

const SANS = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Open Sans", "HarmonyOS Sans SC", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const SERIF = '"Charter", Georgia, Cambria, "Times New Roman", "LXGW WenKai", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif';

let currentPrefs = { ...DEFAULT_PREFS };
let editorViewRef = null;
let userUrls = null;

export function bindThemeEditorView(view) {
  editorViewRef = view;
  if (view) view.requestMeasure();
}

export function getAppearance() {
  return { ...currentPrefs };
}

export function currentThemeId() {
  return currentPrefs.theme || 'white';
}

function isDarkTheme(id = currentThemeId()) {
  return (THEMES.find((t) => t.id === id) || THEMES[0]).dark;
}

export async function initTheme() {
  if (window.studio?.themeUrls) {
    try {
      userUrls = await window.studio.themeUrls();
    } catch {
      userUrls = null;
    }
  }
  loadAppearance();
}

function loadAppearance() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      currentPrefs = { ...DEFAULT_PREFS, ...saved };
    } else {
      saved = null;
      const legacy = localStorage.getItem(LEGACY_KEY);
      currentPrefs = { ...DEFAULT_PREFS, ...(legacy ? { theme: legacy } : {}) };
    }
  } catch {
    saved = null;
    currentPrefs = { ...DEFAULT_PREFS };
  }
  if (!THEMES.some((t) => t.id === currentPrefs.theme)) currentPrefs.theme = 'white';
  if (!saved || saved.lineHeight == null) {
    const density = DENSITY_MAP[currentPrefs.density] || DENSITY_MAP.comfortable;
    currentPrefs.lineHeight = Number(density.lineHeight);
    currentPrefs.paraEm = parseFloat(density.paraSpacing);
    currentPrefs.blockPx = parseInt(density.blockGap, 10);
  }
  if (!saved || saved.contentPx == null) {
    const width = WIDTH_MAP[currentPrefs.pageWidth] || WIDTH_MAP.standard;
    currentPrefs.contentPx = width.endsWith('px') ? parseInt(width, 10) : 800;
  }
  applyAppearance();
  return getAppearance();
}

export function updateAppearance(patch) {
  currentPrefs = { ...currentPrefs, ...patch };
  if (!THEMES.some((t) => t.id === currentPrefs.theme)) currentPrefs.theme = 'white';
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPrefs));
    localStorage.setItem(LEGACY_KEY, currentPrefs.theme);
  } catch {
    /* 隐私模式写不进去时，这一次会话里的外观仍然生效 */
  }
  applyAppearance();
}

export async function applyTheme(id, { silent = false } = {}) {
  if (!THEMES.some((t) => t.id === id)) return;
  updateAppearance({ theme: id });
  if (!silent) document.dispatchEvent(new CustomEvent('theme-change', { detail: { id } }));
}

export function applyAppearanceCommand(spec) {
  const [key, value] = String(spec || '').split(':');
  const now = currentPrefs;
  if (key === 'density' && DENSITY_MAP[value]) {
    const density = DENSITY_MAP[value];
    updateAppearance({
      density: value,
      lineHeight: Number(density.lineHeight),
      paraEm: parseFloat(density.paraSpacing),
      blockPx: parseInt(density.blockGap, 10),
    });
  }
  else if (key === 'width' && WIDTH_MAP[value]) {
    const width = WIDTH_MAP[value];
    updateAppearance({
      pageWidth: value,
      contentPx: width.endsWith('px') ? parseInt(width, 10) : now.contentPx,
    });
  }
  else if (key === 'font' && (value === 'theme' || value === 'sans' || value === 'serif' || value === 'custom')) updateAppearance({ fontStyle: value });
  else if (key === 'size') updateAppearance({ fontSize: Number(value) || 16 });
  else if (key === 'indent') updateAppearance({ firstLineIndent: !now.firstLineIndent });
  else if (key === 'code-ln') updateAppearance({ codeLineNumbers: !now.codeLineNumbers });
  else if (key === 'spell') updateAppearance({ spellcheck: !now.spellcheck });
}

function applyAppearance() {
  const root = document.documentElement;
  const p = currentPrefs;

  root.dataset.theme = p.theme;
  root.dataset.codeLn = p.codeLineNumbers ? '1' : '0';
  document.body.dataset.theme = p.theme;
  document.body.dataset.mode = isDarkTheme(p.theme) ? 'dark' : 'light';

  root.style.setProperty('--editor-font-size', `${p.fontSize}px`);
  root.style.setProperty('--content-width', p.pageWidth === 'full' ? '100%' : `${p.contentPx || 800}px`);
  root.style.setProperty('--line-height', String(p.lineHeight || 1.75));
  root.style.setProperty('--para-spacing', `${p.paraEm ?? 0.8}em`);
  root.style.setProperty('--block-gap', `${p.blockPx ?? 14}px`);
  root.style.setProperty('--para-indent', p.firstLineIndent ? '2em' : '0em');
  if (p.codePx) root.style.setProperty('--code-font-size', `${p.codePx}px`);
  else root.style.setProperty('--code-font-size', '0.875em');

  if (p.fontStyle === 'serif') root.style.setProperty('--font-body', SERIF);
  else if (p.fontStyle === 'sans') root.style.setProperty('--font-body', SANS);
  else if (p.fontStyle === 'custom' && p.fontFamily) root.style.setProperty('--font-body', p.fontFamily);
  else root.style.removeProperty('--font-body');

  const baseUser = document.getElementById('base_user_css');
  const themeUser = document.getElementById('theme_user_css');
  if (userUrls && baseUser && themeUser) {
    baseUser.disabled = false;
    themeUser.disabled = false;
    baseUser.href = userUrls.base;
    if (userUrls[p.theme]) themeUser.href = userUrls[p.theme];
  }

  syncNativeChrome(p.theme);
  document.dispatchEvent(new CustomEvent('appearance-change'));

  if (editorViewRef) {
    requestAnimationFrame(() => {
      editorViewRef.requestMeasure();
      editorViewRef.dispatch({ effects: refreshDecorations.of(null) });
    });
  }
}

function syncNativeChrome(id) {
  if (!window.studio?.setChrome) return;
  const cs = getComputedStyle(document.body);
  const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
  window.studio.setChrome({
    bg: pick('--chrome-bg', pick('--bg-soft', '#e6ebf2')),
    fg: pick('--text', '#24292f'),
    dark: isDarkTheme(id),
  });
}
