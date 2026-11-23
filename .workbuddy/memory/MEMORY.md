# Plume · 长期项目笔记

## 设计与视觉偏好

- 用户偏好清晰、层级分明、结构化的界面，崇尚简洁紧凑布局，沟通用中文。
- 用户说的「设计感」= **概念性巧思（负空间、双重含义）+ 严谨几何构造 + 充分留白**，
  不是通用具象图标。第一版「极简羽毛」被批「毫无设计感」；最终采用字母 P 字标。
  倾向字母构造、一眼看懂产品特性、大气克制。
- 品牌色：深蓝 → 青绿渐变 `#1B3FA0 → #1C7FCB → #12BFAE`；深墨底 `#071729 → #143A5E`。
- 现行 logo（2026-11-23 起）：几何字母 **P**，内孔做成实时预览窗
  （`#` 源码 / 编辑光标 / 渲染标题行），源文件 `design/logo/app-icon.svg`，提案见 `design/logo/proposal.html`。

## 图标生成链路

- 矢量源在 `design/logo/`，`render.mjs` 用 `@resvg/resvg-js`（环境变量 `RESVG_DIR` 指向临时安装目录）导出 PNG。
- 母版 `src-tauri/icons/icon.png` → `npx tauri icon` 重建全套；网页 favicon 为 64px，落在 `public/` 与 `dist/`。
- `md.ico` / `md-icon-preview.png` 是 .md 文件关联用的文档图标，与品牌 logo 无关，不要一起替换。
