import { defineStore } from 'pinia';

/**
 * 外壳状态中枢。
 *
 * 纪律：CodeMirror 的 EditorState 永远不进响应式系统——文档标签里的
 * editorState 由运行时以原始引用挂在普通对象上（见 runtime 的 snapshotDocumentTab），
 * store 里只保留路径等元数据。这里所有字段都是可序列化的普通值。
 */
export const useShellStore = defineStore('shell', {
  state: () => ({
    /** 运行时注册进来的命令 API（非响应式使用，见 main.js 的 markRaw）。 */
    runtime: null,

    // 当前文档
    path: null,
    dir: null,
    fileName: '未命名.md',
    dirty: false,
    words: 0,
    lines: 0,
    hint: '',
    /** 最近一次保存失败的错误信息；非空时状态栏常驻提示并提供重试。 */
    saveError: '',

    // 侧栏与视图
    side: 'files',
    sidebarOpen: true,
    sourceMode: false,
    focusMode: false,
    typewriter: false,

    // 文档标签（仅元数据；EditorState 由运行时自己持有）
    tabs: [],

    // 文件树：组件自管展开/懒加载，运行时通过版本号请求刷新
    fileTreeVersion: 0,

    // 大纲
    outlineItems: [],
    outlineCurrent: -1,
    outlineCollapsed: {},
  }),
  actions: {
    syncDoc({ path, dir }) {
      this.path = path;
      this.dir = dir;
      this.fileName = path ? path.split(/[\\/]/).pop() : '未命名.md';
    },
    setDirty(v) {
      this.dirty = v;
    },
    setStatus({ words, lines }) {
      this.words = words;
      this.lines = lines;
    },
    setHint(msg) {
      this.hint = msg;
      clearTimeout(this._hintTimer);
      if (msg) {
        this._hintTimer = setTimeout(() => {
          this.hint = '';
        }, 2200);
      }
    },
    setSaveError(msg) {
      this.saveError = msg || '';
    },
    setSide(v) {
      this.side = v;
      localStorage.setItem('plume.side', v);
    },
    setSidebar(open) {
      this.sidebarOpen = open;
      localStorage.setItem('plume.sidebar', open ? '1' : '0');
    },
    setSourceMode(v) {
      this.sourceMode = v;
    },
    setFocusMode(v) {
      this.focusMode = v;
    },
    setTypewriter(v) {
      this.typewriter = v;
    },
    syncTabs(tabs) {
      this.tabs = tabs;
    },
    bumpFileTree() {
      this.fileTreeVersion++;
    },
    setOutline(items) {
      this.outlineItems = items;
      if (this.outlineCurrent >= items.length) this.outlineCurrent = -1;
    },
    setOutlineCurrent(i) {
      this.outlineCurrent = i;
    },
    toggleOutlineCollapsed(key) {
      this.outlineCollapsed = { ...this.outlineCollapsed, [key]: !this.outlineCollapsed[key] };
    },
  },
});
