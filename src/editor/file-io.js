/**
 * 磁盘文件读写、自动保存、最近打开与外部修改冲突处理（从 runtime.js 抽离）。
 */
import { Transaction } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { ensureSyntaxTree, unfoldEffect } from '@codemirror/language';
import { refreshDecorations } from './live-preview.js';
import { setEditingImage } from './widgets.js';
import { clearTableSelection } from './table-selection.js';
import { detectDocFormat, serializeForDisk, withTrailingBlank } from './doc-format.js';
import { normalizeMarkdownText } from './rich-doc.js';
import { RECENT_KEY } from './storage-keys.js';
import { docBaseUrl } from '../platform/studio.js';

export function createFileIO({
  state,
  view,
  shell,
  historySlot,
  tabs,
  samePath,
  setDirty,
  writeDraft,
  settleCurrentDocument,
  setDocBase,
  cancelCellEditor,
  forgetMissingPastes,
  settlePastedImages,
  getWordGoal,
  updateStatus,
  renderOutline,
  sidebarVisible,
  sideView,
  openSheet,
  flash,
  onDocLoaded,
}) {
  let autosaveTimer = null;
  let handlingExternalChange = false;

  function browserDownload(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function readRecent() {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }

  function rememberRecent(p) {
    const list = [p, ...readRecent().filter((item) => !samePath(item, p))].slice(0, 8);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* 隐私模式写不进去就只在这一次会话里记住 */
    }
  }

  function loadDoc(content, pathOrName, { keepHistory = false } = {}) {
    Object.assign(state, detectDocFormat(content));
    shell.setWordGoal(getWordGoal(typeof pathOrName === 'string' ? pathOrName : null));
    state.encoding = 'utf-8';
    const text = withTrailingBlank(normalizeMarkdownText(content));
    const oldPath = state.path;
    if (!keepHistory) tabs.snapshotDocumentTab(oldPath);
    const isFullPath = !!pathOrName && /[\\/]/.test(pathOrName);
    const previousTab = !keepHistory && isFullPath ? tabs.findCachedTab(pathOrName, text) : null;
    cancelCellEditor();
    state.path = isFullPath ? pathOrName : null;
    state.dir = isFullPath ? pathOrName.replace(/[\\/][^\\/]*$/, '') : null;
    window.studio?.watchDocument?.(state.path);
    if (isFullPath) rememberRecent(pathOrName);
    forgetMissingPastes(text);
    if (window.studio && isFullPath) {
      setDocBase(docBaseUrl(state.dir));
    } else {
      setDocBase(null);
    }
    if (previousTab) {
      view.setState(previousTab.editorState);
    } else if (keepHistory) {
      if (text !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      }
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
    } else {
      view.dispatch({ effects: historySlot.reconfigure([]) });
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: true,
        effects: historySlot.reconfigure(history()),
        annotations: Transaction.addToHistory.of(false),
      });
    }
    setDirty(false);
    if (isFullPath) {
      if (keepHistory) tabs.replaceTabPath(oldPath, pathOrName);
      else tabs.snapshotDocumentTab(pathOrName);
    }
    tabs.syncTabs();
    updateStatus('');
    renderOutline();
    if (sidebarVisible() && sideView() === 'files') shell.bumpFileTree();
    if (typeof onDocLoaded === 'function') onDocLoaded(state.path);
  }

  function openDiskDoc(r) {
    loadDoc(r.content, r.path);
    state.encoding = String(r.encoding || 'utf-8').toLowerCase();
    if (state.encoding !== 'utf-8') {
      flash(`已按 ${state.encoding.toUpperCase()} 编码打开，保存时保持原编码`);
    }
  }

  async function openFile() {
    if (!(await settleCurrentDocument())) return;
    if (window.studio) {
      const r = await window.studio.openDialog();
      if (r) openDiskDoc(r);
    } else {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
      input.onchange = async () => {
        const f = input.files[0];
        if (!f) return;
        loadDoc(await f.text(), f.name);
      };
      input.click();
    }
  }

  async function openRecent(p) {
    if (!p || !window.studio?.readFile || !(await settleCurrentDocument())) return;
    try {
      const r = await window.studio.readFile(p);
      openDiskDoc(r);
    } catch {
      const list = readRecent().filter((item) => !samePath(item, p));
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } catch {
        /* ignore */
      }
      flash('打不开这个文件，已从最近列表移除');
    }
  }

  function scheduleAutosave() {
    if (!state.autosave || !state.path || !window.studio) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      if (!state.dirty || !state.path) return;
      const targetPath = state.path;
      const content = view.state.doc.toString();
      try {
        await window.studio.saveFile(targetPath, serializeForDisk(content, state), state.encoding);
        if (state.path === targetPath && view.state.doc.toString() === content) {
          setDirty(false);
          flash('已自动保存');
        } else {
          setDirty(true);
          scheduleAutosave();
        }
      } catch (e) {
        writeDraft();
        shell.setSaveError(String(e?.message || e));
        flash('自动保存失败，草稿已保留');
      }
    }, 1200);
  }

  async function saveAs() {
    const content = view.state.doc.toString();
    if (!window.studio) {
      browserDownload('未命名.md', serializeForDisk(content, state), 'text/markdown');
      setDirty(false);
      return true;
    }
    const p = await window.studio.saveAsDialog(serializeForDisk(content, state), state.path || undefined);
    if (!p) return false;
    const settled = await settlePastedImages(content, p);
    if (settled !== content) await window.studio.saveFile(p, serializeForDisk(settled, state), 'utf-8');
    const { eol, bom } = state;
    loadDoc(settled, p, { keepHistory: true });
    state.eol = eol;
    state.bom = bom;
    flash('已另存为 ' + p.split(/[\\/]/).pop());
    return true;
  }

  async function save() {
    let content = view.state.doc.toString();
    if (!window.studio) {
      const name = state.path || '未命名.md';
      browserDownload(name, serializeForDisk(content, state), 'text/markdown');
      setDirty(false);
      return true;
    }
    if (state.path) {
      const targetPath = state.path;
      content = await settlePastedImages(content, targetPath);
      if (content !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
        });
        forgetMissingPastes(content);
      }
      try {
        await window.studio.saveFile(targetPath, serializeForDisk(content, state), state.encoding);
      } catch (err) {
        shell.setSaveError(String(err?.message || err));
        throw err;
      }
      if (state.path === targetPath && view.state.doc.toString() === content) {
        setDirty(false);
        flash('已保存 ' + targetPath.split(/[\\/]/).pop());
      } else {
        setDirty(true);
        scheduleAutosave();
        flash('已保存旧快照，较新的修改仍待保存');
      }
      return true;
    }
    return saveAs();
  }

  async function newDoc() {
    if (!(await settleCurrentDocument())) return;
    loadDoc('', null);
    state.path = null;
    setDirty(false);
    view.focus();
  }

  function askExternalConflict() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      openSheet(
        '文件已在其他程序中修改',
        (body, close) => {
          const text = document.createElement('p');
          text.className = 'settings-note';
          text.textContent = '磁盘上的内容与当前编辑不一致，如何处理？';
          const hint = document.createElement('p');
          hint.className = 'settings-note';
          hint.textContent =
            '「保留我的编辑」继续当前内容，保存时会覆盖磁盘版本；' +
            '「载入磁盘版本」放弃当前未保存的修改；「取消」暂不处理，继续编辑。';
          const row = document.createElement('div');
          row.className = 'ask-actions';
          const main = document.createElement('div');
          main.className = 'ask-group';
          const side = document.createElement('div');
          side.className = 'ask-group';
          for (const [label, value, kind, group] of [
            ['保留我的编辑', 'keep', 'primary', main],
            ['载入磁盘版本', 'load', 'danger', main],
            ['取消', 'cancel', 'ghost', side],
          ]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'btn-' + kind;
            b.textContent = label;
            b.addEventListener('click', () => {
              done(value);
              close();
            });
            group.appendChild(b);
          }
          row.append(main, side);
          body.append(text, hint, row);
        },
        { onClose: () => done('cancel') },
      );
    });
  }

  let pendingFocusRefresh = false;
  let pendingExternalFile = null;

  function refreshAfterExternalReload() {
    if (!view || !view.dom?.isConnected) return;
    // 尽量同步补齐语法树，再强制重算块级/行内装饰与布局测量，避免后台重载后样式错乱
    try {
      ensureSyntaxTree(view.state, Math.min(view.state.doc.length, 200000), 120);
    } catch {
      /* ignore */
    }
    view.dispatch({ effects: refreshDecorations.of(null) });
    view.requestMeasure();
  }

  function reloadFromDisk(content, encoding) {
    Object.assign(state, detectDocFormat(content));
    state.encoding = String(encoding || 'utf-8').toLowerCase();
    const text = withTrailingBlank(normalizeMarkdownText(content));
    const sel = view.state.selection.main;
    const prevLen = view.state.doc.length;
    cancelCellEditor();
    clearTableSelection();
    view.dispatch({
      changes: { from: 0, to: prevLen, insert: text },
      selection: {
        anchor: Math.min(sel.anchor, text.length),
        head: Math.min(sel.head, text.length),
      },
      effects: [
        setEditingImage.of(null),
        unfoldEffect.of({ from: 0, to: prevLen }),
        refreshDecorations.of(null),
      ],
      scrollIntoView: true,
    });
    forgetMissingPastes(text);
    setDirty(false);
    tabs.snapshotDocumentTab(state.path);
    updateStatus('');
    renderOutline();
    if (typeof document !== 'undefined' && (!document.hasFocus() || document.hidden)) {
      pendingFocusRefresh = true;
    }
    requestAnimationFrame(refreshAfterExternalReload);
  }

  function bindExternalChange() {
    if (typeof window !== 'undefined') {
      const onResume = () => {
        if (!pendingFocusRefresh) return;
        pendingFocusRefresh = false;
        requestAnimationFrame(refreshAfterExternalReload);
      };
      window.addEventListener('focus', onResume);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) onResume();
      });
    }

    const handleFileChange = async (file) => {
      if (!samePath(file, state.path)) return;
      if (handlingExternalChange) {
        // Cursor 连续快速写入（如流式改写 + 格式化保存）时记住最后一次，不丢最终版本
        pendingExternalFile = file;
        return;
      }
      handlingExternalChange = true;
      try {
        const r = await window.studio.readFile(file);
        if (withTrailingBlank(normalizeMarkdownText(r.content)) === view.state.doc.toString()) return;
        if (state.dirty) {
          const choice = await askExternalConflict();
          if (choice === 'keep') {
            setDirty(true);
            flash('已保留当前编辑，保存时将覆盖磁盘版本');
            return;
          }
          if (choice !== 'load') return;
        }
        reloadFromDisk(r.content, r.encoding);
        flash('已载入磁盘上的最新版本');
      } catch (err) {
        flash('无法读取外部修改：' + (err?.message || err));
      } finally {
        handlingExternalChange = false;
        if (pendingExternalFile) {
          const next = pendingExternalFile;
          pendingExternalFile = null;
          if (samePath(next, state.path)) handleFileChange(next);
        }
      }
    };

    window.studio?.onExternalChange?.(handleFileChange);
  }

  async function reloadModifiedFiles(paths) {
    if (!Array.isArray(paths) || !paths.length || !state.path || !window.studio?.readFile) return;
    const curNorm = String(state.path).replace(/\\/g, '/').toLowerCase();
    const hit = paths.some((p) => String(p).replace(/\\/g, '/').toLowerCase() === curNorm);
    if (hit && !state.dirty) {
      try {
        const doc = await window.studio.readFile(state.path);
        if (doc && typeof doc.content === 'string') {
          loadDoc(doc.content, state.path, { keepHistory: true });
          setDirty(false);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    browserDownload,
    readRecent,
    rememberRecent,
    loadDoc,
    openDiskDoc,
    openFile,
    openRecent,
    save,
    saveAs,
    newDoc,
    scheduleAutosave,
    reloadFromDisk,
    bindExternalChange,
    reloadModifiedFiles,
  };
}
