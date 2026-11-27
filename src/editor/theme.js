import { refreshDecorations } from './live-preview.js';
import { APPEARANCE_KEY } from './storage-keys.js';
import { THEMES } from './theme-catalog.js';

export { THEMES };

const LEGACY_KEY = 'mdstudio.theme';
const STORAGE_KEY = APPEARANCE_KEY;

const DEFAULT_PREFS = {
  theme: 'white',
  fontStyle: 'theme',
  fontFamily: '',
  fontSize: 16,
  density: 'comfortable',
  lineHeight: 1.75,
  paraEm: 0.85,
  blockPx: 18,
  pageWidth: 'standard',
  contentPx: 750,
  codePx: 0,
  firstLineIndent: false,
  codeLineNumbers: true,
  spellcheck: false,
  /** 导出排版模板：doc（文档）/ book（书籍）/ paper（论文），见 export-style.js */
  exportTemplate: 'doc',
};

const DENSITY_MAP = {
  compact: { lineHeight: '1.62', paraSpacing: '0.5em', blockGap: '10px' },
  comfortable: { lineHeight: '1.75', paraSpacing: '0.85em', blockGap: '18px' },
  loose: { lineHeight: '1.9', paraSpacing: '1.15em', blockGap: '24px' },
};

const WIDTH_MAP = {
  narrow: '680px',
  standard: '750px',
  wide: '880px',
  full: '100%',
};

const SANS = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Open Sans", "HarmonyOS Sans SC", "PingFang SC", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
const SERIF = '"Charter", Georgia, Cambria, "Times New Roman", "LXGW WenKai", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", SimSun, serif';

let currentPrefs = { ...DEFAULT_PREFS };
const editorViewRefs = new Set();
let userUrls = null;

export function bindThemeEditorView(view) {
  if (!view) return;
  editorViewRefs.add(view);
  view.requestMeasure();
}

export function unbindThemeEditorView(view) {
  if (!view) return;
  editorViewRefs.delete(view);
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
    currentPrefs.contentPx = width.endsWith('px') ? parseInt(width, 10) : 750;
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

export function resetAppearance() {
  currentPrefs = { ...DEFAULT_PREFS };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPrefs));
    localStorage.setItem(LEGACY_KEY, currentPrefs.theme);
  } catch {
    /* ignore */
  }
  applyAppearance();
  document.dispatchEvent(new CustomEvent('theme-change', { detail: { id: currentPrefs.theme } }));
  return getAppearance();
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
  else if (key === 'export-style' && value) updateAppearance({ exportTemplate: value });
}

function applyAppearance() {
  const root = document.documentElement;
  const p = currentPrefs;

  root.dataset.theme = p.theme;
  root.dataset.codeLn = p.codeLineNumbers ? '1' : '0';
  document.body.dataset.theme = p.theme;
  document.body.dataset.mode = isDarkTheme(p.theme) ? 'dark' : 'light';

  root.style.setProperty('--editor-font-size', `${p.fontSize}px`);
  root.style.setProperty('--content-width', p.pageWidth === 'full' ? '100%' : `${p.contentPx || 750}px`);
  root.style.setProperty('--line-height', String(p.lineHeight || 1.75));
  root.style.setProperty('--para-spacing', `${p.paraEm ?? 0.85}em`);
  root.style.setProperty('--block-gap', `${p.blockPx ?? 18}px`);
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

  if (editorViewRefs.size) {
    requestAnimationFrame(() => {
      for (const v of editorViewRefs) {
        if (!v?.dom?.isConnected) continue;
        v.requestMeasure();
        v.dispatch({ effects: refreshDecorations.of(null) });
      }
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
