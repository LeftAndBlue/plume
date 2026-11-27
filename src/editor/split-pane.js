/**
 * 右侧分栏编辑器管理：分栏开关、互换、提升为主栏、比例拖拽与自动保存（从 runtime.js 抽离）。
 */
import { nextTick } from 'vue';
import { Compartment, EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history } from '@codemirror/commands';
import { refreshDecorations, sourceModeField, setSourceMode } from './live-preview.js';
import { setDocBaseEffect } from './widgets.js';
import { bindThemeEditorView, getAppearance, unbindThemeEditorView } from './theme.js';
import { detectDocFormat, serializeForDisk, withTrailingBlank } from './doc-format.js';
import { normalizeMarkdownText } from './rich-doc.js';
import { SPLIT_RATIO_KEY } from './storage-keys.js';
import { docBaseUrl } from '../platform/studio.js';

export function createSplitPane({
  state,
  shell,
  getPrimaryView,
  createEditorExtensions,
  bindViewScrollSync,
  bindViewInteractions,
  samePath,
  setDirty,
  loadDoc,
  browserDownload,
  updateStatus,
  renderOutline,
  scheduleStatus,
  scheduleOutline,
  syncOutlineCurrent,
  placeFmtPop,
  syncWindowChrome,
  getTabs,
  flash,
}) {
  const splitState = {
    path: null,
    dir: null,
    dirty: false,
    autosave: true,
    eol: '\n',
    bom: false,
    encoding: 'utf-8',
  };
  let splitView = null;
  let splitHistorySlot = null;
  let splitAutosaveTimer = null;

  function focusPane(pane) {
    const next = pane === 'split' && splitState.path ? 'split' : 'primary';
    if (shell.activePane === next) return;
    shell.setActivePane(next);
    updateStatus();
    renderOutline();
    syncWindowChrome();
  }

  function setSplitDirty(v) {
    splitState.dirty = !!v;
    if (!splitState.dirty) clearTimeout(splitAutosaveTimer);
    shell.setSplitDirty(splitState.dirty);
    syncWindowChrome();
  }

  function scheduleSplitAutosave() {
    if (!splitState.autosave || !splitState.path || !window.studio) return;
    clearTimeout(splitAutosaveTimer);
    splitAutosaveTimer = setTimeout(async () => {
      if (!splitState.dirty || !splitState.path || !splitView) return;
      const targetPath = splitState.path;
      const content = splitView.state.doc.toString();
      try {
        await window.studio.saveFile(targetPath, serializeForDisk(content, splitState), splitState.encoding);
        if (splitState.path === targetPath && splitView?.state.doc.toString() === content) {
          setSplitDirty(false);
          flash('已自动保存');
        } else {
          setSplitDirty(true);
          scheduleSplitAutosave();
        }
      } catch (e) {
        shell.setSaveError(String(e?.message || e));
        flash('分栏文档自动保存失败');
      }
    }, 1200);
  }

  async function saveSplit() {
    if (!splitView || !splitState.path) return true;
    const content = splitView.state.doc.toString();
    if (!window.studio) {
      browserDownload(splitState.path.split(/[\\/]/).pop() || '未命名.md', serializeForDisk(content, splitState), 'text/markdown');
      setSplitDirty(false);
      return true;
    }
    const targetPath = splitState.path;
    await window.studio.saveFile(targetPath, serializeForDisk(content, splitState), splitState.encoding);
    if (splitState.path === targetPath && splitView?.state.doc.toString() === content) {
      setSplitDirty(false);
      flash('已保存 ' + targetPath.split(/[\\/]/).pop());
    }
    return true;
  }

  async function settleSplitDocument() {
    if (!splitState.path || !splitState.dirty) return true;
    if (!splitView || !splitView.state.doc.toString().trim()) return true;
    let choice = 'cancel';
    if (window.studio?.unsaved) choice = await window.studio.unsaved();
    else if (window.confirm('右侧分栏文档有未保存的更改。确定先保存并继续吗？')) choice = 'save';
    if (choice === 'cancel') return false;
    if (choice === 'discard') return true;
    try {
      return await saveSplit();
    } catch (err) {
      flash('保存失败，已取消关闭分栏：' + (err?.message || err));
      return false;
    }
  }

  function applySplitRatio(ratio) {
    const clamped = Math.max(0.2, Math.min(0.8, Number(ratio) || 0.5));
    const area = document.getElementById('editor-area');
    if (area) area.style.setProperty('--split-ratio', String(clamped));
    return clamped;
  }

  function bindSplitDivider() {
    const saved = Number(localStorage.getItem(SPLIT_RATIO_KEY));
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) applySplitRatio(saved);
    const divider = document.getElementById('split-divider');
    const area = document.getElementById('editor-area');
    if (!divider || !area || divider.dataset.bound) return;
    divider.dataset.bound = '1';
    divider.addEventListener('dblclick', () => {
      const r = applySplitRatio(0.5);
      try {
        localStorage.setItem(SPLIT_RATIO_KEY, String(r));
      } catch {
        /* ignore */
      }
    });
    divider.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      document.body.classList.add('split-dragging');
      const rect = area.getBoundingClientRect();
      const move = (ev) => {
        if (rect.width <= 0) return;
        const r = applySplitRatio((ev.clientX - rect.left) / rect.width);
        area.dataset.splitRatio = String(r);
      };
      const up = () => {
        document.body.classList.remove('split-dragging');
        try {
          if (area.dataset.splitRatio) localStorage.setItem(SPLIT_RATIO_KEY, area.dataset.splitRatio);
        } catch {
          /* ignore */
        }
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  async function readDocForSplit(path) {
    if (window.studio?.readFile) return window.studio.readFile(path);
    const tabs = getTabs();
    const cached = tabs.documentTabs.find((t) => samePath(t.path, path) && t.editorState);
    if (cached) return { path, content: cached.editorState.doc.toString(), encoding: 'utf-8' };
    throw new Error('当前环境无法读取文件');
  }

  function mountOrUpdateSplitView(text, nextBase, sourceOn) {
    const splitHost = document.getElementById('split-editor-host');
    if (!splitHost) return false;
    if (!splitView) {
      splitHistorySlot = new Compartment();
      splitView = new EditorView({
        parent: splitHost,
        state: EditorState.create({
          doc: text,
          extensions: createEditorExtensions({
            historySlot: splitHistorySlot,
            getDocState: () => splitState,
            getDocView: () => splitView,
            onFocus: () => focusPane('split'),
            onUpdate: (u) => {
              if (u.docChanged) {
                setSplitDirty(true);
                scheduleSplitAutosave();
                if (shell.activePane === 'split') scheduleOutline();
              }
              if ((u.docChanged || u.selectionSet) && shell.activePane === 'split') scheduleStatus();
              if (u.selectionSet) {
                if (shell.activePane === 'split') {
                  requestAnimationFrame(() => syncOutlineCurrent());
                }
                const fmt = document.getElementById('fmt-pop');
                if (u.view.state.selection.main.empty) {
                  if (fmt) fmt.hidden = true;
                } else if (fmt && !fmt.hidden) {
                  requestAnimationFrame(() => placeFmtPop(u.view));
                }
              }
            },
          }),
        }),
      });
      splitView.dispatch({
        effects: [setDocBaseEffect.of(nextBase), setSourceMode.of(sourceOn)],
      });
      bindViewScrollSync(splitView);
      bindViewInteractions(splitView, 'split');
      bindThemeEditorView(splitView);
    } else {
      splitView.dispatch({ effects: splitHistorySlot.reconfigure([]) });
      splitView.dispatch({
        changes: { from: 0, to: splitView.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
        effects: [
          splitHistorySlot.reconfigure(history()),
          setDocBaseEffect.of(nextBase),
          setSourceMode.of(sourceOn),
        ],
        annotations: Transaction.addToHistory.of(false),
      });
    }
    if (splitView.contentDOM) splitView.contentDOM.spellcheck = !!getAppearance().spellcheck;
    bindSplitDivider();
    return true;
  }

  async function openSplit(path, { focus = true } = {}) {
    if (!path) return false;
    if (samePath(path, state.path)) {
      flash('当前文件已在主编辑区打开，请选择其他文件进行分栏');
      return false;
    }
    if (splitState.path && samePath(path, splitState.path)) {
      if (focus) {
        focusPane('split');
        splitView?.focus();
      }
      return true;
    }
    if (!(await settleSplitDocument())) return false;
    let docRes;
    try {
      docRes = await readDocForSplit(path);
    } catch (err) {
      flash('分栏打开失败：' + (err?.message || err));
      return false;
    }
    Object.assign(splitState, detectDocFormat(docRes.content));
    splitState.path = path;
    splitState.dir = path.replace(/[\\/][^\\/]*$/, '');
    splitState.encoding = String(docRes.encoding || 'utf-8').toLowerCase();
    splitState.dirty = false;
    clearTimeout(splitAutosaveTimer);
    shell.setSplitDoc(path);
    shell.setSplitDirty(false);
    getTabs().ensureTab(path);

    await nextTick();
    if (!splitState.path || !samePath(splitState.path, path)) return false;

    const view = getPrimaryView();
    const text = withTrailingBlank(normalizeMarkdownText(docRes.content));
    const nextBase = window.studio ? docBaseUrl(splitState.dir) : null;
    const sourceOn = !!view.state.field(sourceModeField, false);
    if (!mountOrUpdateSplitView(text, nextBase, sourceOn)) return false;
    if (focus) {
      focusPane('split');
      splitView.focus();
    } else {
      syncWindowChrome();
    }
    return true;
  }

  async function closeSplit({ settle = true } = {}) {
    if (!splitState.path) return true;
    if (settle && !(await settleSplitDocument())) return false;
    clearTimeout(splitAutosaveTimer);
    if (splitView) {
      unbindThemeEditorView(splitView);
      splitView.destroy();
      splitView = null;
    }
    splitHistorySlot = null;
    splitState.path = null;
    splitState.dir = null;
    splitState.dirty = false;
    splitState.eol = '\n';
    splitState.bom = false;
    splitState.encoding = 'utf-8';
    shell.setSplitDoc(null);
    getTabs().syncTabs();
    focusPane('primary');
    syncWindowChrome();
    getPrimaryView().focus();
    return true;
  }

  async function promoteSplitToPrimary() {
    if (!splitState.path || !splitView) return false;
    const nextPath = splitState.path;
    const nextText = splitView.state.doc.toString();
    const nextDirty = splitState.dirty;
    const nextMeta = { eol: splitState.eol, bom: splitState.bom, encoding: splitState.encoding };
    const nextSel = splitView.state.selection.main;
    const nextScroll = splitView.scrollDOM.scrollTop;
    await closeSplit({ settle: false });
    loadDoc(nextText, nextPath, { snapshotOld: false });
    Object.assign(state, nextMeta);
    const view = getPrimaryView();
    view.dispatch({
      selection: {
        anchor: Math.min(nextSel.anchor, view.state.doc.length),
        head: Math.min(nextSel.head, view.state.doc.length),
      },
    });
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = nextScroll;
    });
    setDirty(nextDirty);
    view.focus();
    return true;
  }

  async function swapSplit() {
    if (!splitState.path || !splitView) return false;
    if (!state.path) {
      flash('未保存的空白文档无法移到分栏，请先保存');
      return false;
    }
    const view = getPrimaryView();
    const left = {
      path: state.path,
      text: view.state.doc.toString(),
      dirty: state.dirty,
      eol: state.eol,
      bom: state.bom,
      encoding: state.encoding,
      sel: view.state.selection.main,
      scroll: view.scrollDOM.scrollTop,
    };
    const right = {
      path: splitState.path,
      text: splitView.state.doc.toString(),
      dirty: splitState.dirty,
      eol: splitState.eol,
      bom: splitState.bom,
      encoding: splitState.encoding,
      sel: splitView.state.selection.main,
      scroll: splitView.scrollDOM.scrollTop,
    };
    // 先清空 splitPath 再加载主编辑区，避免 snapshot/sync 冲突
    splitState.path = right.path;
    loadDoc(right.text, right.path, { snapshotOld: false });
    Object.assign(state, { eol: right.eol, bom: right.bom, encoding: right.encoding });
    setDirty(right.dirty);
    view.dispatch({
      selection: {
        anchor: Math.min(right.sel.anchor, view.state.doc.length),
        head: Math.min(right.sel.head, view.state.doc.length),
      },
    });

    Object.assign(splitState, {
      path: left.path,
      dir: left.path.replace(/[\\/][^\\/]*$/, ''),
      dirty: left.dirty,
      eol: left.eol,
      bom: left.bom,
      encoding: left.encoding,
    });
    shell.setSplitDoc(left.path);
    shell.setSplitDirty(left.dirty);
    const nextBase = window.studio ? docBaseUrl(splitState.dir) : null;
    const sourceOn = !!view.state.field(sourceModeField, false);
    mountOrUpdateSplitView(left.text, nextBase, sourceOn);
    splitView.dispatch({
      selection: {
        anchor: Math.min(left.sel.anchor, splitView.state.doc.length),
        head: Math.min(left.sel.head, splitView.state.doc.length),
      },
    });
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = right.scroll;
      if (splitView) splitView.scrollDOM.scrollTop = left.scroll;
    });
    getTabs().syncTabs();
    updateStatus();
    renderOutline();
    syncWindowChrome();
    return true;
  }

  async function reloadSplitIfNeeded(paths) {
    if (!Array.isArray(paths) || !paths.length || !splitState.path || !splitView || !window.studio?.readFile) return;
    const hit = paths.some((p) => samePath(p, splitState.path));
    if (hit && !splitState.dirty) {
      try {
        const doc = await window.studio.readFile(splitState.path);
        if (doc && typeof doc.content === 'string') {
          const text = withTrailingBlank(normalizeMarkdownText(doc.content));
          Object.assign(splitState, detectDocFormat(doc.content));
          splitState.encoding = String(doc.encoding || 'utf-8').toLowerCase();
          splitView.dispatch({
            changes: { from: 0, to: splitView.state.doc.length, insert: text },
            effects: refreshDecorations.of(null),
          });
          setSplitDirty(false);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    splitState,
    getSplitView: () => splitView,
    focusPane,
    saveSplit,
    settleSplitDocument,
    openSplit,
    closeSplit,
    promoteSplitToPrimary,
    swapSplit,
    reloadSplitIfNeeded,
  };
}
