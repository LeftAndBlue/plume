/**
 * 界面文案 i18n。
 *
 * - zh-CN 是源语言；en 为对照翻译。缺键时回退 zh-CN，再回退键名本身。
 * - locale 放进 Vue reactive：组件模板里调 t() 会自动跟随语言切换重渲染。
 * - 命令式 UI（菜单表、设置面板）在每次打开时取词；菜单栏顶栏按钮由
 *   locale-change 事件通知 menubar.refreshLabels() 刷新。
 * - 语言偏好存 localStorage（LOCALE_KEY），参与设置备份。
 *
 * 迁移进度：外壳组件 / 菜单表 / 设置面板 / 快速打开已接入；
 * flash 提示、对话框、右键菜单、主题页与帮助文案仍为中文（第二批）。
 */
import { reactive } from "vue";
import { LOCALE_KEY } from "./editor/storage-keys.js";

const zhCN = {
  "chrome.menu": "菜单",
  "chrome.dragHint": "拖动窗口，双击最大化",
  "chrome.unsaved": "● 未保存",
  "chrome.minimize": "最小化",
  "chrome.maximize": "最大化 / 还原",
  "chrome.close": "关闭",
  "chrome.mainMenu": "主菜单",

  "tabs.aria": "打开的文档",
  "tabs.close": "关闭标签",

  "status.toggleSidebar": "展开 / 收起侧栏",
  "status.toggleSidebarAria": "展开或收起侧栏",
  "status.sourceMode": "源代码模式 (Ctrl+/)",
  "status.sourceModeAria": "源代码模式",
  "status.saveError": "保存失败 · 点击重试",
  "status.retrySave": "点击重试保存",
  "status.countTitle": "字数与阅读时间",
  "status.words": "{n} 字",
  "status.lines": "{n} 行",

  "side.files": "文件",
  "side.outline": "大纲",
  "side.searchPlaceholder": "搜索文件名或正文",
  "side.searchAria": "搜索文件",
  "side.newDoc": "在当前目录新建文档",
  "side.newDocAria": "新建文档",
  "side.newDir": "在当前目录新建文件夹",
  "side.newDirAria": "新建文件夹",
  "side.optsAria": "搜索选项",
  "side.matchCase": "区分大小写",
  "side.wholeWord": "全词匹配",
  "side.regex": "正则表达式",
  "side.wholeWordBadge": "全词",
  "side.resize": "拖动调整侧栏宽度",

  "tree.notFound": "没有找到「{q}」。",
  "tree.truncated": "已达 200 条上限，可能还有更多结果，请细化关键词。",
  "tree.noDoc": "还没有打开文档，文件树会显示它所在的目录。",
  "tree.openFile": "打开文件…",
  "tree.loading": "读取目录…",
  "tree.empty": "这个目录里没有 Markdown 文件。",
  "tree.tooMany": "文件太多，只显示了前 300 项。用上面的搜索缩小范围。",
  "tree.lineNo": "第 {n} 行",
  "tree.fileName": "文件名",
  "tree.emptyDir": "空目录",

  "outline.empty": "当前文档没有标题",
  "outline.expand": "展开子标题",
  "outline.collapse": "折叠子标题",

  "fmt.bold": "加粗",
  "fmt.italic": "斜体",
  "fmt.strike": "删除线",
  "fmt.code": "行内代码",
  "fmt.link": "链接",
  "fmt.highlight": "高亮",

  "settings.title": "设置",
  "settings.closeAria": "关闭设置",
  "settings.general": "通用",
  "settings.language": "语言",
  "settings.appearance": "外观",
  "settings.theme": "主题",
  "settings.density": "密度",
  "settings.density.compact": "紧凑",
  "settings.density.comfortable": "舒适",
  "settings.density.loose": "疏朗",
  "settings.fontSize": "正文字号",
  "settings.lineHeight": "行距",
  "settings.paraEm": "段间距",
  "settings.blockPx": "块间距",
  "settings.contentPx": "版心宽度",
  "settings.pageFull": "全宽",
  "settings.fontStyle": "字体",
  "settings.fontStyle.theme": "跟随主题",
  "settings.fontStyle.sans": "无衬线",
  "settings.fontStyle.serif": "衬线",
  "settings.fontStyle.custom": "自定义",
  "settings.fontFamily": "自定义字体",
  "settings.fontFamilyPh": "例如 Georgia, SimSun",
  "settings.codePx": "代码字号",
  "settings.firstLineIndent": "首行缩进",
  "settings.codeLineNumbers": "代码行号",
  "settings.appearanceNote": "代码字号为 0 时跟随正文。行距、段间距和块间距会立刻作用到这篇文档。",
  "settings.openThemeStore": "打开主题商店",
  "settings.exportGroup": "导出排版",
  "settings.exportTemplate": "导出模板",
  "settings.exportTemplate.doc": "文档（无衬线）",
  "settings.exportTemplate.book": "书籍（衬线 / 首行缩进）",
  "settings.exportTemplate.paper": "论文（窄栏 / 两端对齐）",
  "settings.exportTemplateNote": "PDF 和长图按这里的模板分页排版，配色与字体跟随当前主题；深色主题导出 PDF 会自动换成浅色配色。HTML 导出内联同一套样式。",
  "settings.spelling": "拼写",
  "settings.spellcheck": "拼写检查",
  "settings.spellLoading": "正在读取词典…",
  "settings.spellNote": "英语词典会下载到本机。文档里的红线仍使用系统拼写引擎。中文没有单独的下载包，跟着系统里已经安装的语言走。",
  "settings.images": "图片",
  "settings.imageFolder": "图片目录",
  "settings.imageFolderPh": "assets 或 media/images",
  "settings.imageNote": "新粘贴和拖入的图片保存到文档旁的该目录。可点击整理，把本文已有的本地图片复制进去并更新引用；原图不会删除。",
  "settings.collectImages": "整理本文图片",
  "settings.clearRecent": "清空最近打开",
  "settings.backup": "备份",
  "settings.backupNote": "把外观、图片目录、界面布局与最近打开列表导出为 JSON，换机或重装后导入恢复。不含文档内容。",
  "settings.export": "导出设置…",
  "settings.import": "导入设置…",

  "menu.file": "文件",
  "menu.view": "视图",
  "menu.theme": "主题",
  "menu.help": "帮助",
  "menu.new": "新建",
  "menu.open": "打开…",
  "menu.quickOpen": "快速打开…",
  "menu.copyMarkdown": "复制为 Markdown",
  "menu.save": "保存",
  "menu.saveAs": "另存为…",
  "menu.exportHtml": "导出 HTML…",
  "menu.exportHtmlBare": "导出 HTML（无样式）…",
  "menu.exportDocx": "导出 Word…",
  "menu.exportRtf": "导出 RTF…",
  "menu.exportEpub": "导出 EPUB…",
  "menu.exportLatex": "导出 LaTeX…",
  "menu.exportPng": "导出图片…",
  "menu.exportPdf": "导出 PDF…",
  "menu.closeWindow": "关闭窗口",
  "menu.fileTree": "文件树",
  "menu.outline": "大纲",
  "menu.showSidebar": "显示侧栏",
  "menu.sourceMode": "源代码模式",
  "menu.focusMode": "专注模式",
  "menu.typewriter": "打字机模式",
  "menu.spellcheck": "拼写检查",
  "menu.settings": "设置…",
  "menu.shortcuts": "快捷键参考",
  "menu.checkUpdate": "检查更新…",
  "menu.license": "许可",
  "menu.about": "关于 Plume",
  "update.title": "软件更新",
  "update.available": "发现新版本 {v}",
  "update.current": "当前版本 {v}",
  "update.install": "立即更新",
  "update.later": "稍后",
  "update.downloading": "正在下载… {p}%",
  "update.installing": "正在安装，应用即将重启…",
  "update.done": "更新完成，正在重启…",
  "update.latest": "已是最新版本",
  "update.failed": "更新失败：",
  "update.checking": "正在检查更新…",
  "update.failedTitle": "检查更新失败",
  "update.networkHint": "若处于需要代理的网络，请确认系统代理已开启后重试。",
  "update.retry": "重试",
  "update.close": "关闭",

  "quick.title": "快速打开",
  "quick.placeholder": "输入文件名或内容关键词…",
  "quick.aria": "快速打开搜索",
  "quick.hint": "↑↓ 选择 · Enter 打开 · Esc 关闭",
  "quick.empty": "输入关键词开始搜索",
  "quick.noMatch": "没有匹配的文件",
  "quick.lineSub": "第 {n} 行 · {text}",
};

const en = {
  "chrome.menu": "Menu",
  "chrome.dragHint": "Drag to move, double-click to maximize",
  "chrome.unsaved": "● Unsaved",
  "chrome.minimize": "Minimize",
  "chrome.maximize": "Maximize / Restore",
  "chrome.close": "Close",
  "chrome.mainMenu": "Main menu",

  "tabs.aria": "Open documents",
  "tabs.close": "Close tab",

  "status.toggleSidebar": "Toggle sidebar",
  "status.toggleSidebarAria": "Toggle sidebar",
  "status.sourceMode": "Source mode (Ctrl+/)",
  "status.sourceModeAria": "Source mode",
  "status.saveError": "Save failed · Click to retry",
  "status.retrySave": "Click to retry saving",
  "status.countTitle": "Word count and reading time",
  "status.words": "{n} words",
  "status.lines": "{n} lines",

  "side.files": "Files",
  "side.outline": "Outline",
  "side.searchPlaceholder": "Search file names or content",
  "side.searchAria": "Search files",
  "side.newDoc": "New document in current folder",
  "side.newDocAria": "New document",
  "side.newDir": "New folder in current folder",
  "side.newDirAria": "New folder",
  "side.optsAria": "Search options",
  "side.matchCase": "Match case",
  "side.wholeWord": "Whole word",
  "side.regex": "Regular expression",
  "side.wholeWordBadge": "ab",
  "side.resize": "Drag to resize the sidebar",

  "tree.notFound": "No results for “{q}”.",
  "tree.truncated": "Reached the 200-result limit; there may be more. Refine your query.",
  "tree.noDoc": "No document open yet. The file tree shows its folder.",
  "tree.openFile": "Open file…",
  "tree.loading": "Reading folder…",
  "tree.empty": "No Markdown files in this folder.",
  "tree.tooMany": "Too many files; showing the first 300. Use search above to narrow down.",
  "tree.lineNo": "Line {n}",
  "tree.fileName": "File name",
  "tree.emptyDir": "Empty folder",

  "outline.empty": "No headings in this document",
  "outline.expand": "Expand subheadings",
  "outline.collapse": "Collapse subheadings",

  "fmt.bold": "Bold",
  "fmt.italic": "Italic",
  "fmt.strike": "Strikethrough",
  "fmt.code": "Inline code",
  "fmt.link": "Link",
  "fmt.highlight": "Highlight",

  "settings.title": "Settings",
  "settings.closeAria": "Close settings",
  "settings.general": "General",
  "settings.language": "Language",
  "settings.appearance": "Appearance",
  "settings.theme": "Theme",
  "settings.density": "Density",
  "settings.density.compact": "Compact",
  "settings.density.comfortable": "Comfortable",
  "settings.density.loose": "Loose",
  "settings.fontSize": "Body font size",
  "settings.lineHeight": "Line height",
  "settings.paraEm": "Paragraph spacing",
  "settings.blockPx": "Block spacing",
  "settings.contentPx": "Content width",
  "settings.pageFull": "Full width",
  "settings.fontStyle": "Font",
  "settings.fontStyle.theme": "Follow theme",
  "settings.fontStyle.sans": "Sans-serif",
  "settings.fontStyle.serif": "Serif",
  "settings.fontStyle.custom": "Custom",
  "settings.fontFamily": "Custom font",
  "settings.fontFamilyPh": "e.g. Georgia, SimSun",
  "settings.codePx": "Code font size",
  "settings.firstLineIndent": "First-line indent",
  "settings.codeLineNumbers": "Code line numbers",
  "settings.appearanceNote": "Code size 0 follows the body text. Line, paragraph and block spacing apply to this document immediately.",
  "settings.openThemeStore": "Open theme store",
  "settings.exportGroup": "Export layout",
  "settings.exportTemplate": "Export template",
  "settings.exportTemplate.doc": "Document (sans-serif)",
  "settings.exportTemplate.book": "Book (serif / first-line indent)",
  "settings.exportTemplate.paper": "Paper (narrow / justified)",
  "settings.exportTemplateNote": "PDF and long image use this template for paging; colours and fonts follow the current theme, and dark themes switch to a light palette in PDF. HTML export inlines the same styles.",
  "settings.spelling": "Spelling",
  "settings.spellcheck": "Spell check",
  "settings.spellLoading": "Loading dictionaries…",
  "settings.spellNote": "English dictionaries are downloaded locally. Red squiggles still use the system spell engine. Chinese has no separate pack; it follows the languages installed on your system.",
  "settings.images": "Images",
  "settings.imageFolder": "Image folder",
  "settings.imageFolderPh": "assets or media/images",
  "settings.imageNote": "Pasted and dropped images are saved to this folder next to the document. Use Collect to copy existing local images into it and update references; originals are kept.",
  "settings.collectImages": "Collect document images",
  "settings.clearRecent": "Clear recent files",
  "settings.backup": "Backup",
  "settings.backupNote": "Export appearance, image folder, layout and the recent list as JSON; import to restore after a reinstall or on a new machine. Documents are not included.",
  "settings.export": "Export settings…",
  "settings.import": "Import settings…",

  "menu.file": "File",
  "menu.view": "View",
  "menu.theme": "Themes",
  "menu.help": "Help",
  "menu.new": "New",
  "menu.open": "Open…",
  "menu.quickOpen": "Quick open…",
  "menu.copyMarkdown": "Copy as Markdown",
  "menu.save": "Save",
  "menu.saveAs": "Save as…",
  "menu.exportHtml": "Export HTML…",
  "menu.exportHtmlBare": "Export HTML (unstyled)…",
  "menu.exportDocx": "Export Word…",
  "menu.exportRtf": "Export RTF…",
  "menu.exportEpub": "Export EPUB…",
  "menu.exportLatex": "Export LaTeX…",
  "menu.exportPng": "Export image…",
  "menu.exportPdf": "Export PDF…",
  "menu.closeWindow": "Close window",
  "menu.fileTree": "File tree",
  "menu.outline": "Outline",
  "menu.showSidebar": "Show sidebar",
  "menu.sourceMode": "Source mode",
  "menu.focusMode": "Focus mode",
  "menu.typewriter": "Typewriter mode",
  "menu.spellcheck": "Spell check",
  "menu.settings": "Settings…",
  "menu.shortcuts": "Shortcut reference",
  "menu.checkUpdate": "Check for updates…",
  "menu.license": "License",
  "menu.about": "About Plume",
  "update.title": "Software update",
  "update.available": "Version {v} is available",
  "update.current": "Current version: {v}",
  "update.install": "Update now",
  "update.later": "Later",
  "update.downloading": "Downloading… {p}%",
  "update.installing": "Installing; the app will restart…",
  "update.done": "Update complete, restarting…",
  "update.latest": "You're up to date",
  "update.failed": "Update failed: ",
  "update.checking": "Checking for updates…",
  "update.failedTitle": "Update check failed",
  "update.networkHint": "If your network requires a proxy, make sure the system proxy is on and retry.",
  "update.retry": "Retry",
  "update.close": "Close",

  "quick.title": "Quick open",
  "quick.placeholder": "Type a file name or content keyword…",
  "quick.aria": "Quick open search",
  "quick.hint": "↑↓ select · Enter open · Esc close",
  "quick.empty": "Type a keyword to search",
  "quick.noMatch": "No matching files",
  "quick.lineSub": "Line {n} · {text}",
};

const MESSAGES = { "zh-CN": zhCN, en };

export const LOCALES = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
];

function readLocale() {
  try {
    const v = localStorage.getItem(LOCALE_KEY);
    if (v && MESSAGES[v]) return v;
  } catch {
    /* 存储不可用时用默认语言 */
  }
  return "zh-CN";
}

export const i18n = reactive({ locale: readLocale() });

/** 取词；{name} 占位符用 vars 插值。缺键回退源语言，再回退键名。 */
export function t(key, vars) {
  const table = MESSAGES[i18n.locale] || zhCN;
  let s = table[key] ?? zhCN[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

export function setLocale(id) {
  if (!MESSAGES[id] || i18n.locale === id) return;
  i18n.locale = id;
  try {
    localStorage.setItem(LOCALE_KEY, id);
  } catch {
    /* 记不住语言也不影响这次会话 */
  }
  document.documentElement.lang = id;
  document.dispatchEvent(new CustomEvent("locale-change", { detail: { locale: id } }));
}

document.documentElement.lang = i18n.locale;