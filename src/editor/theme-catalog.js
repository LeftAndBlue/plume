/**
 * 主题清单唯一来源：theme.js（界面切换）与 export-style.js（导出装配）共用，
 * 新增主题只需放一份 CSS 到 styles/themes/<id>.css 并在此登记即可。
 */
export const THEMES = [
  { id: 'white', label: 'White（浅色）', dark: false, swatch: ['#ffffff', '#2563eb', '#24292f'] },
  { id: 'sepia', label: 'Sepia（羊皮纸）', dark: false, swatch: ['#f6f0e6', '#8a5a2b', '#3e3426'] },
  { id: 'vue', label: 'Vue（翠竹）', dark: false, swatch: ['#ffffff', '#42b883', '#2c3e50'] },
  { id: 'night', label: 'Night（深色）', dark: true, swatch: ['#1c2028', '#58a6ff', '#d4d7dd'] },
  { id: 'github', label: 'GitHub', dark: false, swatch: ['#ffffff', '#0969da', '#1f2328'] },
  { id: 'newsprint', label: 'Newsprint（报纸）', dark: false, swatch: ['#f4ecd8', '#8a5a2b', '#3e3426'] },
  { id: 'pixyll', label: 'Pixyll', dark: false, swatch: ['#ffffff', '#0074d9', '#333333'] },
  { id: 'gothic', label: 'Gothic（哥特）', dark: true, swatch: ['#0e0e0e', '#d8d8d8', '#ececec'] },
  { id: 'lapis', label: 'Lapis（青金石）', dark: false, swatch: ['#ffffff', '#4870ac', '#354152'] },
  { id: 'orangeheart', label: 'Orange Heart（橙心）', dark: false, swatch: ['#ffffff', '#ef7060', '#333333'] },
  { id: 'solarized', label: 'Solarized（暖阳）', dark: false, swatch: ['#fdf6e3', '#268bd2', '#586e75'] },
  { id: 'drake', label: 'Drake（暗夜）', dark: true, swatch: ['#1e222a', '#e95f59', '#d0d7e2'] },
  { id: 'nord', label: 'Nord（北欧极光）', dark: true, swatch: ['#2e3440', '#88c0d0', '#d8dee9'] },
  { id: 'onedark', label: 'One Dark（原子深空）', dark: true, swatch: ['#282c34', '#61afef', '#abb2bf'] },
];

export const DARK_THEME_IDS = new Set(THEMES.filter((t) => t.dark).map((t) => t.id));
