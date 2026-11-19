# Plume

Typora 式 WYSIWYG Markdown 编辑器：**Tauri 2 + Rust + Vue 3 + Pinia + TailwindCSS + Lucide + CodeMirror 6**。
仅面向 Windows（WebView2），由原 Electron 版「墨行 Markline」重构而来。

## 架构分层

```
src/                        前端（Vite + Vue 3）
├─ platform/studio.js       Tauri 平台适配层：保持原 window.studio API 表面，
│                           所有系统能力经 invoke 落到 Rust；本地资源走 asset protocol
├─ stores/shell.js          Pinia 外壳状态（文档/侧栏/标签/大纲/提示）
├─ components/              Vue 外壳：TitleBar（自绘三键）、Sidebar、FileTree、
│                           OutlinePanel、DocumentTabs、StatusBar
├─ editor/
│  ├─ runtime.js            编辑器运行时（原 index.js 改造）：命令表、文档/导出/图片、
│  │                        菜单页与设置面板等命令式弹层
│  ├─ live-preview.js …     CM6 编辑器内核（原样保留，与框架无关）
│  └─ styles/               编辑器与外壳主题：CSS 变量 + 全量主题文件 + data-theme 切换
└─ App.vue / main.js        组合根；启动顺序：installPlatform → Pinia → mount → initRuntime

src-tauri/                  Rust 系统服务层
├─ src/fs_ops.rs            文档读写（原子保存）、目录列举、跨文件搜索、文件树操作
├─ src/watch.rs             notify 目录监听：doc-external-change / fs-changed（去抖）
├─ src/images.rs            图片落盘 / 归集 / 移动 / 回收站
├─ src/exports.rs           HTML 自包含（内嵌图片 + KaTeX 字体）、DOCX/LaTeX/EPUB
├─ src/webview_print.rs     Windows 打印链路：隐藏 WebView2 → PrintToPdf / CapturePreview
└─ src/lib.rs               commands、export:// 协议、窗口与系统对话框
```

关键纪律：**CodeMirror 的 EditorState 不进 Pinia**。文档标签的编辑器状态由运行时
以原始引用持有，Pinia 里只放路径等元数据，避免响应式包装拖垮编辑器。

样式分工：Tailwind 提供外壳新组件的布局/间距工具类（关闭 preflight），
编辑器与外壳主题视觉仍由 CSS 变量 + 主题文件驱动（8 套内置主题 + 用户主题目录）。
图标统一 Lucide（`lucide-vue-next`）。

## 开发

```bash
npm install
npm run dev:app        # = tauri dev（先起 Vite，再编译 Rust 并打开窗口）
```

也可以直接双击项目根目录的 `dev.bat`（内置 vcvars 初始化 + cargo PATH）。

纯前端调试：`npm run dev`（浏览器打开 http://localhost:1420，桌面能力自动降级）。

## 以 exe 应用形式运行

**直接双击运行（推荐）**：release 构建会把前端 `dist/` 内嵌进 exe，无需启动任何开发服务器。

```bash
npm run tauri build    # 或 npm run dist（只打 NSIS）
```

产物：
- 绿色单文件：`src-tauri/target/release/plume.exe`，双击即用。
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/Plume_0.1.0_x64-setup.exe`，
  按当前用户安装，安装后可从开始菜单 / 桌面快捷方式启动。

**注意**：`src-tauri/target/debug/plume.exe` 是开发构建，页面地址指向
`http://localhost:1420`，单独双击会显示「localhost 拒绝连接」。
调试构建必须配合 `npm run dev`（或直接用 `npm run dev:app` 一条命令）才能显示界面。

构建本机需先初始化 MSVC 环境（`vcvars64.bat`）再执行上述 npm 命令。

## 打包（Windows / NSIS）

```bash
npm run dist           # vite build + tauri build --bundles nsis
```

或双击项目根目录的 `build.bat`。产物在 `src-tauri/target/release/bundle/nsis/`，
可直接分发的单文件是 `src-tauri/target/release/plume.exe`（前端已内嵌）。

首次打包时 tauri CLI 会从 GitHub 下载 NSIS 3.13 到本地缓存（`%LOCALAPPDATA%\tauri`）。
网络不通会报 `failed to bundle project: timeout: global`——此时先挂代理再重试，
或手动下载 `nsis-3.13.zip`（tauri-apps/binary-releases）后重试；exe 本身不受影响。

图标：`src-tauri/icons/icon.png` 来自用户提供的 logo，自动裁出主体、居中并保留透明背景，
`npx tauri icon src-tauri/icons/icon.png` 可重新生成全套。

## 环境依赖

- Node 22+、Rust stable（MSVC toolchain）、Visual Studio C++ 生成工具、WebView2 Runtime。
- 本机 crates 走 rsproxy 镜像（`.cargo/config.toml`）。

## Markdown 标记的触发时机

块级标记不是「敲出来就立刻套样式」，而是提交后才生效（只约束正在输入的那一行）：

| 输入 | 行为 |
|---|---|
| `-`、`*`、`+`、`1.` | 先显示原字符，**补一个空格**才变成列表 |
| `>` | 先显示原字符，**补一个空格**才套用引用样式 |
| `#` | 先显示原字符，**补一个空格**才变成标题 |
| ` ```cs ` | 行内保持源码，**按回车**才生成代码块并补出结尾围栏 |

这样写「-3」「#话题」这类内容时不会被误判成列表或标题。
已有文档里的裸标记行（光标不在该行）仍按 CommonMark 原样渲染。
对应回归断言在 `src/editor/selftest.js` 的「块级标记的空格提交门槛」小节。

补充：CommonMark 里段落下方的 `-` 哪怕只有一个字符也构成 **Setext 下划线**（二级标题），
所以在正文下一行敲 `-` 会让上一行突然变成标题。现在同样受上面的门槛约束：
正在输入的裸 `-` 不触发标题样式，`--` 及以上才按 Setext 标题渲染。
注意 `-` 加空格紧跟在段落后时，CommonMark 仍优先判为 Setext 下划线而不是列表；
想在段落后开始列表，请先空一行再输入 `- `。

### 本地图片加载（Tauri asset protocol）

WebView2 **不允许页面加载 `file://` 子资源**，所以本地图片必须走 asset protocol：

- 绝对路径（`C:\...`、UNC）：`widgets.js` 的 `resolveSrc` 通过 `setLocalUrlConverter`
  交给 `studio.js` 的 `localFileUrl`（`convertFileSrc`），不再生成 `file:///`。
  浏览器 dev / 自检环境仍用 `file://`，行为不变。
- 相对路径（`assets/x.png`）：文档基址由 `docBaseUrl(dir)` 给出。
  **不能**直接 `convertFileSrc(dir + '/')`——它把分隔符也编码成 `%2F`，
  `new URL(relative, base)` 会把整个目录当成一个 segment，结果拼成
  `http://asset.localhost/assets/x.png`（根目录）而加载失败。
  现在按路径段分别编码、保留 `/`，相对解析才正确。
- 空格等字符：`resolveSrc` 先编码 `?`/`#`，文件名空格用 `%20` 即可。

已在 release（`http://tauri.localhost`）实测：绝对路径、相对路径、带空格文件名
的图片均能加载（`naturalWidth = 2048`），`file://` 对照组加载失败。

### 引用行的 Backspace

- 引用行正文删空后，行内不会再留下一个光秃秃的 `>`（空内容时标记收起，光标仍在行尾可见）；
- 在空引用行按 Backspace：**整行一次删掉**，引用样式随之消失。后面还有内容时只移除这一行，
  不会把前后两行正文并成一行；已经是最后一行时退掉上一行的换行，光标回到上一行末尾；
- 光标贴在引用正文开头时按 Backspace：退一级引用，嵌套引用（`> >`）只退最内一层，
  顶层引用退回普通段落，正文不动；
- 光标在正文中间时不拦截，按普通字符删除。对应断言在自检「13.56 引用行 Backspace」。



## 链接打开

编辑区内 **Ctrl（macOS 为 Cmd）+ 鼠标左键** 用系统默认浏览器打开链接，
支持 `[文字](地址)`、`<https://…>`、裸写 `https://…` 与 `www.…`（自动补 https）。
光标所在行会展开成 Markdown 源码，这时 Ctrl+点击同样有效（按语法树取地址）。
`#锚点` 走页内标题跳转，相对路径不打开；打开失败会在编辑器里提示，不再静默。

## 文件关联与打开方式

- 安装包（NSIS）会注册 `.md` / `.markdown` 文件关联，安装后**双击文档**即可用 Plume 打开；也可以右键文档选择「打开方式 → Plume」。
- 冷启动时，命令行传入的文档路径会在启动后自动打开（`plume.exe "C:\path\to\doc.md"`）。
- 应用**已运行**时再次打开文档，不会新开窗口：单实例插件把路径转发给已运行的实例，在同一窗口中打开（有未保存修改时先走三态询问）。
- 免安装版 `plume.exe` 不带注册表关联，可手动通过「打开方式」选择该 exe，或用上面的命令行方式打开。

## 与原 Electron 版的差异 / 已知限制

- PDF 导出用 WebView2 `PrintToPdf`（`with_webview` + COM），PNG 长图用
  `ExecuteScript` 量高 + `CapturePreview`（上限 14000px），不再依赖 Electron 打印管线。
- 自绘窗口三键（Tauri 无 `titleBarOverlay`）；外壳背景色由前端 CSS 变量负责。
  拖动由 `startDragging()` 实现（WebView2 不认 `-webkit-app-region`）：标题栏空白与文件名区域可拖，
  三键、汉堡菜单、菜单栏经 `composedPath` 明确排除，按住按钮已不会再拖动窗口。
- 拼写检查使用 WebView2 系统引擎，没有 Electron 的词典下载链路。
- 未保存询问是应用内三态面板（保存 / 不保存 / 取消），系统对话框无法区分后两者。
- 文件拖入走 Tauri 原生 drag-drop 事件拿真实路径（HTML5 drop 被宿主接管）。
- 本地图片经 asset protocol（scope `**`，与 Electron 的 file:// 直读等价，适合单机编辑器）。

## 验证记录

- `npm run build`：通过（Vite 生产构建）。
- `cargo check` / `cargo build --release`：通过（Rust 侧无错误，仅剩可忽略的未用函数）。
- release exe 实际启动：窗口、自绘三键、侧栏文件/大纲切换、文档标签、未保存标记、外壳配色均正常。
- 未保存三态面板：关闭窗口（自绘 X / 系统 WM_CLOSE）时由 Rust 拦下
  `CloseRequested` 并转发 `plume:close-requested`，前端弹出「保存并关闭 / 不保存 / 取消」。
- NSIS 打包：本机首次因 GitHub 下载 NSIS 超时未完成，exe 不受影响（见上文）。
- 标记触发门槛：`src/editor/live-preview.js` 的 `bareMarkLine` 只在光标所在行且行内仅有标记时抑制装饰；
  自检 215/220，通过项包含新增的 6 条触发断言，其余 5 项失败与本次改动前的基线完全一致
  （KaTeX 内嵌样式、隐藏窗口下的回车模拟、代码块圆角取样式、localStorage 草稿键，均为 dev 自检环境既有问题）。
- 自检可在 dev 页面跑：`npm run dev` 后访问 `http://localhost:1420/?selftest=1`，结果面板在页面底部。

