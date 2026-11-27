/**
 * Plume 桌面平台适配层：Tauri 实现。
 *
 * 刻意保持与旧 Electron preload 相同的 `window.studio` API 表面，
 * 编辑器运行时（editor/runtime.js）因此不需要关心宿主是 Electron 还是 Tauri。
 * 所有文件系统与系统能力都落在 Rust 侧（src-tauri），这里只做参数编组与事件转发。
 */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

const toBytes = (buf) => Array.from(new Uint8Array(buf));

/**
 * 文档基址：Tauri 下本地资源走 asset protocol（Windows 为 http://asset.localhost）。
 * 不能直接 convertFileSrc(dir + '/')：它把路径分隔符也编码成 %2F，
 * URL 解析时整个目录只剩一个 segment，相对图片会被拼到根目录（/assets/x.png）而加载失败。
 * 这里逐段编码、保留 '/'，让 new URL(relative, base) 能正确相对解析。
 */
export function docBaseUrl(dir) {
  if (!dir) return null;
  const prefix = convertFileSrc(''); // http://asset.localhost/ 或 asset://localhost/
  const encoded = dir.replace(/[\\/]+$/, '').split(/[\\/]+/).map(encodeURIComponent).join('/');
  return prefix + encoded + '/';
}

/** 本地绝对路径：WebView2 不允许页面加载 file:// 子资源，必须走 asset protocol。 */
export function localFileUrl(path) {
  return convertFileSrc(path);
}

function bindListener(subscribe) {
  let disposed = false;
  let unlisten = null;
  Promise.resolve(subscribe())
    .then((fn) => {
      if (disposed) {
        if (typeof fn === 'function') fn();
      } else {
        unlisten = fn;
      }
    })
    .catch(() => {});
  return () => {
    disposed = true;
    if (typeof unlisten === 'function') unlisten();
    unlisten = null;
  };
}

function createStudio() {
  const win = getCurrentWindow();
  return {
    isElectron: false,
    isTauri: true,

    info: () => invoke('app_info'),
    themeUrls: async () => {
      const paths = await invoke('theme_paths');
      const urls = {};
      for (const [key, value] of Object.entries(paths)) urls[key] = convertFileSrc(value);
      return urls;
    },

    openDialog: () => invoke('file_open'),
    pickSettingsFile: () => invoke('settings_import_pick'),
    readFile: (p) => invoke('file_read', { p }),
    readFileBytes: async (p) => new Uint8Array(await invoke('file_read_bytes', { p })),
    saveFile: (p, c, enc) => invoke('file_save', { p, c, enc }),
    saveAsDialog: (c, s) => invoke('file_save_as', { c, s }),

    listDir: (d) => invoke('fs_list', { d }),
    searchFiles: (dir, query, opts) => invoke('fs_search', { dir, query, opts }),
    replaceInFiles: (dir, query, replacement, opts) => invoke('fs_replace', { dir, query, replacement, opts }),
    createFsEntry: (root, dir, name, directory) => invoke('fs_create', { root, dir, name, directory }),
    renameFsEntry: (root, source, name) => invoke('fs_rename', { root, source, name }),
    trashFsEntry: (root, source) => invoke('fs_trash', { root, source }),
    moveFsEntry: (root, source, destDir) => invoke('fs_move', { root, source, destDir }),
    showFsEntry: (root, source) => invoke('fs_show', { root, source }),
    watchDocument: (p) => invoke('doc_watch', { p }),

    saveImage: (buf, ext, docPath, folder) =>
      invoke('image_save', { buf: toBytes(buf), ext, docPath, folder }),
    adoptImage: (absPath, docPath, folder) => invoke('image_adopt', { absPath, docPath, folder }),
    collectImages: (sources, docPath, folder) => invoke('image_collect', { sources, docPath, folder }),
    moveImages: (sources, docPath, folder) => invoke('image_move', { sources, docPath, folder }),
    trashImage: (source, docPath) => invoke('image_trash', { source, docPath }),
    uploadImage: (absPath, server) => invoke('image_upload', { absPath, server }),
    pingImageUploader: (server) => invoke('image_upload_ping', { server }),
    uploadImageEasyimage: (absPath, base, token) => invoke('image_upload_easyimage', { absPath, base, token }),
    pingEasyimage: (base) => invoke('image_easyimage_ping', { base }),

    exportHtml: (html, s, docDir) => invoke('export_html', { html, s, docDir }),
    exportPdf: (html, s, docDir) => invoke('export_pdf', { html, s, docDir }),
    exportPng: (html, s, docDir) => invoke('export_png', { html, s, docDir }),
    exportDocx: (bytes, s) => invoke('export_docx', { bytes: toBytes(bytes), s }),
    exportFile: (payload) =>
      invoke('export_file', { payload: { ...payload, bytes: payload.bytes ? toBytes(payload.bytes) : undefined } }),

    confirm: (m) => invoke('dialog_confirm', { m }),
    // 三态「保存/不保存/取消」由应用内面板实现（系统对话框的 YesNoCancel 无法区分后两者）
    unsaved: () => (window.__plumeUnsaved ? window.__plumeUnsaved() : Promise.resolve('cancel')),
    showInfo: (payload) => invoke('dialog_info', { payload }),
    openThemeFolder: () => invoke('theme_open_folder'),

    // 拼写检查直接使用 WebView2 的系统引擎，没有 Electron 那种词典下载链路。
    setSpellcheck: () => Promise.resolve({ enabled: true }),
    listSpell: () =>
      Promise.resolve({
        system: [],
        dictionaries: [
          { id: 'en', label: '英语（跟随系统）', installed: true, systemOnly: true },
          { id: 'zh-CN', label: '中文（跟随系统）', installed: true, systemOnly: true },
        ],
      }),
    downloadSpell: () => Promise.reject(new Error('Plume 使用系统拼写引擎，无需下载词典')),

    setDirty: (v) => invoke('state_dirty', { v }).catch(() => {}),
    setTitle: (t) => invoke('state_title', { t }).catch(() => {}),
    setChrome: (c) => invoke('chrome_theme', { c }).catch(() => {}),
    quit: () => invoke('app_quit').catch(() => {}),
    openExternal: (u) => invoke('shell_open_external', { u }),
    // 冷启动时由命令行传入、待打开的文档（文件关联「打开方式」/双击文档），只取一次
    takeInitialFile: () => invoke('take_initial_file'),

    onCommand: (cb) => bindListener(() => listen('cmd', (e) => cb(e.payload))),
    onExternalChange: (cb) => bindListener(() => listen('doc-external-change', (e) => cb(e.payload))),
    onFsChanged: (cb) => bindListener(() => listen('fs-changed', (e) => cb(e.payload))),

    /** Tauri 的原生拖放事件（dragDropEnabled 时 HTML5 drop 不触发，路径只能从这里拿）。 */
    onNativeDrop: (cb) =>
      bindListener(() =>
        win.onDragDropEvent((event) => {
          if (event.payload.type === 'drop') cb(event.payload.paths);
        }),
      ),
    /** 窗口关闭请求：Rust 侧拦截 WM_CLOSE 后转发给前端，前端处理完未保存文档再真正退出。 */
    onCloseRequested: (cb) =>
      bindListener(() =>
        listen('plume:close-requested', () => {
          Promise.resolve(cb()).catch(() => {});
        }),
      ),
    /** 应用已运行时再次打开文档（单实例回调转发），payload 为文件路径。 */
    onOpenFile: (cb) =>
      bindListener(() =>
        listen('plume:open-file', (e) => {
          Promise.resolve(cb(e.payload)).catch(() => {});
        }),
      ),
  };
}

export function installPlatform() {
  if (isTauri) window.studio = createStudio();
  return window.studio || null;
}
