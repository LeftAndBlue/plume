/**
 * 文件树操作（新建、重命名、删除、移动）、路径打开与跨文件搜索定位（从 runtime.js 抽离）。
 */
import { docBaseUrl } from '../platform/studio.js';
import { blinkLine, setDocBaseEffect } from './widgets.js';

export function samePath(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

export function createFsOpsUI({
  state,
  shell,
  getPrimaryView,
  getSplitState,
  getSplitView,
  setDirty,
  syncWindowChrome,
  settleCurrentDocument,
  settleSplitDocument,
  closeSplit,
  loadDoc,
  openDiskDoc,
  focusPane,
  recordJumpOrigin,
  remapDocumentTabs,
  removeDocumentTabsUnder,
  syncTabs,
  openSheet,
  closeSettings,
  flash,
}) {
  async function askText(title, initial = '', fieldLabel = '名称', placeholder = '') {
    return new Promise((resolve) => {
      const ph = placeholder ? ` placeholder="${String(placeholder).replace(/"/g, '&quot;')}"` : '';
      openSheet(
        title,
        `<label class="settings-row"><span>${String(fieldLabel).replace(/</g, '&lt;')}</span><input id="ask-text-value" type="text"${ph} value="${String(initial).replace(/"/g, '&quot;')}"></label>` +
          `<div class="settings-actions"><button id="ask-text-ok" class="settings-btn">确定</button><button id="ask-text-cancel" class="settings-btn">取消</button></div>`,
      );
      const input = document.getElementById('ask-text-value');
      const finish = (value) => {
        closeSettings();
        resolve(value);
      };
      document.getElementById('ask-text-ok')?.addEventListener('click', () => finish(input ? input.value.trim() : null), { once: true });
      document.getElementById('ask-text-cancel')?.addEventListener('click', () => finish(null), { once: true });
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input ? input.value.trim() : null);
        if (e.key === 'Escape') finish(null);
      });
      input?.focus();
      input?.select();
    });
  }

  async function openTreePath(path) {
    const splitState = getSplitState();
    const splitView = getSplitView();
    if (splitState.path && samePath(path, splitState.path)) {
      focusPane('split');
      splitView?.focus();
      return;
    }
    if (!(await settleCurrentDocument())) return;
    try {
      const r = await window.studio.readFile(path);
      openDiskDoc(r);
    } catch (err) {
      flash('打开失败：' + (err?.message || err));
    }
  }

  async function createFsEntry(dir, directory) {
    const rootDir = state.dir || shell.dir;
    if (!rootDir || !window.studio?.createFsEntry) return flash('请先打开一个文档目录');
    const name = await askText(directory ? '新建文件夹' : '新建 Markdown 文档', directory ? '新建文件夹' : '未命名.md');
    if (!name) return;
    try {
      const created = await window.studio.createFsEntry(rootDir, dir || rootDir, name, directory);
      shell.bumpFileTree();
      if (!directory && created) {
        await openTreePath(created);
      }
      flash(directory ? '文件夹已创建' : '文档已创建');
    } catch (err) {
      flash('创建失败：' + (err?.message || err));
    }
  }

  function pathInsideEntry(targetPath, entry) {
    if (!targetPath) return false;
    if (samePath(targetPath, entry.path)) return true;
    if (!entry.dir) return false;
    const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
    return norm(targetPath).startsWith(norm(entry.path) + '\\') || norm(targetPath).startsWith(norm(entry.path) + '/');
  }

  function currentInsideEntry(entry) {
    return pathInsideEntry(state.path, entry);
  }

  async function renameFsEntry(entry) {
    const splitState = getSplitState();
    const splitView = getSplitView();
    const name = await askText('重命名', entry.name);
    if (!name || name === entry.name) return;
    if (currentInsideEntry(entry) && !(await settleCurrentDocument())) return;
    if (pathInsideEntry(splitState.path, entry) && !(await settleSplitDocument())) return;
    try {
      const oldPath = state.path;
      const oldSplitPath = splitState.path;
      const rootDir = state.dir || shell.dir;
      const renamed = await window.studio.renameFsEntry(rootDir, entry.path, name);
      if (currentInsideEntry(entry) && oldPath) {
        state.path = renamed + oldPath.slice(entry.path.length);
        window.studio?.watchDocument?.(state.path);
        setDirty(false);
      }
      if (pathInsideEntry(oldSplitPath, entry) && oldSplitPath) {
        splitState.path = renamed + oldSplitPath.slice(entry.path.length);
        splitState.dir = splitState.path.replace(/[\\/][^\\/]*$/, '');
        shell.setSplitDoc(splitState.path);
        if (splitView) {
          splitView.dispatch({ effects: setDocBaseEffect.of(docBaseUrl(splitState.dir)) });
        }
        syncWindowChrome();
      }
      remapDocumentTabs(entry.path, renamed);
      syncTabs();
      shell.bumpFileTree();
      flash('已重命名');
    } catch (err) {
      flash('重命名失败：' + (err?.message || err));
    }
  }

  async function trashFsEntry(entry) {
    const splitState = getSplitState();
    const ok = window.studio?.confirm
      ? await window.studio.confirm(`确定把「${entry.name}」移到回收站吗？`)
      : window.confirm(`确定把「${entry.name}」移到回收站吗？`);
    if (!ok) return;
    const contained = currentInsideEntry(entry);
    const splitContained = pathInsideEntry(splitState.path, entry);
    if (contained && !(await settleCurrentDocument())) return;
    if (splitContained && !(await settleSplitDocument())) return;
    try {
      const rootDir = state.dir || shell.dir;
      await window.studio.trashFsEntry(rootDir, entry.path);
      if (splitContained) {
        await closeSplit({ settle: false });
      }
      if (contained) {
        loadDoc('', null);
        removeDocumentTabsUnder(entry.path);
        syncTabs();
      } else if (splitContained) {
        removeDocumentTabsUnder(entry.path);
        syncTabs();
      }
      shell.bumpFileTree();
      flash('已移到回收站');
    } catch (err) {
      flash('删除失败：' + (err?.message || err));
    }
  }

  async function moveFsEntry(source, destDir) {
    const splitState = getSplitState();
    const splitView = getSplitView();
    const sourceEntry = { path: source, dir: true };
    const contained = currentInsideEntry(sourceEntry);
    const splitContained = pathInsideEntry(splitState.path, sourceEntry);
    if (contained && !(await settleCurrentDocument())) return;
    if (splitContained && !(await settleSplitDocument())) return;
    const oldPath = state.path;
    const oldSplitPath = splitState.path;
    try {
      const rootDir = state.dir || shell.dir;
      const moved = await window.studio.moveFsEntry(rootDir, source, destDir);
      if (contained && oldPath) {
        state.path = moved + oldPath.slice(source.length);
        window.studio?.watchDocument?.(state.path);
        setDirty(false);
      }
      if (splitContained && oldSplitPath) {
        splitState.path = moved + oldSplitPath.slice(source.length);
        splitState.dir = splitState.path.replace(/[\\/][^\\/]*$/, '');
        shell.setSplitDoc(splitState.path);
        if (splitView) {
          splitView.dispatch({ effects: setDocBaseEffect.of(docBaseUrl(splitState.dir)) });
        }
        syncWindowChrome();
      }
      remapDocumentTabs(source, moved);
      syncTabs();
      shell.bumpFileTree();
      flash('已移动');
    } catch (err) {
      flash('移动失败：' + (err?.message || err));
    }
  }

  async function copyText(text, success = '已复制') {
    try {
      await navigator.clipboard.writeText(String(text || ''));
      flash(success);
      return true;
    } catch {
      flash('无法写入剪贴板');
      return false;
    }
  }

  async function openSearchedFile(hit) {
    const splitState = getSplitState();
    const splitView = getSplitView();
    if (splitState.path && samePath(hit.path, splitState.path) && splitView) {
      focusPane('split');
      splitView.focus();
      if (hit.line > 1) {
        const line = splitView.state.doc.line(Math.min(hit.line, splitView.state.doc.lines));
        const anchor = Math.min(line.to, line.from + Math.max(0, hit.col || 0));
        splitView.dispatch({ selection: { anchor }, scrollIntoView: true });
        blinkLine(splitView, line.from);
      }
      return;
    }
    recordJumpOrigin();
    if (!(await settleCurrentDocument())) return;
    try {
      const r = await window.studio.readFile(hit.path);
      openDiskDoc(r);
      const view = getPrimaryView();
      if (hit.line > 1 && view) {
        const line = view.state.doc.line(Math.min(hit.line, view.state.doc.lines));
        const anchor = Math.min(line.to, line.from + Math.max(0, hit.col || 0));
        view.dispatch({
          selection: { anchor },
          scrollIntoView: true,
        });
        blinkLine(view, line.from);
      }
    } catch (err) {
      flash('打开失败：' + (err && err.message ? err.message : err));
    }
  }

  return {
    askText,
    createFsEntry,
    renameFsEntry,
    trashFsEntry,
    moveFsEntry,
    copyText,
    openTreePath,
    openSearchedFile,
  };
}
