/**
 * 多标签页状态与会话恢复管理（从 runtime.js 抽离）。
 * 约束：EditorState 永远留在此处普通数组里，不进入 Pinia 响应式系统。
 */
import { SESSION_KEY } from './storage-keys.js';

export function createTabsManager({
  state,
  view,
  shell,
  samePath,
  settleCurrentDocument,
  openDiskDoc,
  loadDoc,
  flash,
  tabsEnabled = true,
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
  getStudio = () => (typeof window !== 'undefined' ? window.studio : null),
  getSplitPath = () => null,
  onBeforeCloseSplit = async () => true,
  onPromoteSplit = null,
  onFocusPane = null,
  onRestoreSplit = null,
}) {
  /** @type {Array<{ path: string, editorState: any }>} */
  const documentTabs = [];

  function persistSession() {
    const studio = getStudio();
    if (!tabsEnabled || !studio || !storage) return;
    try {
      const tabs = documentTabs.map((t) => t.path).filter(Boolean);
      const split = getSplitPath?.() || null;
      if (!tabs.length && !state.path && !split) {
        storage.removeItem(SESSION_KEY);
        return;
      }
      storage.setItem(
        SESSION_KEY,
        JSON.stringify({ tabs, active: state.path, split, updatedAt: Date.now() }),
      );
    } catch {
      /* 存储不可用时退化为不恢复会话 */
    }
  }

  function syncTabs() {
    const splitPath = getSplitPath?.() || null;
    shell.syncTabs(
      documentTabs.map((tab) => ({
        path: tab.path,
        active: samePath(tab.path, state.path),
        split: !!splitPath && samePath(tab.path, splitPath),
      })),
    );
    persistSession();
  }

  async function restoreSession() {
    if (!storage) return;
    let session = null;
    try {
      session = JSON.parse(storage.getItem(SESSION_KEY) || 'null');
    } catch {
      return;
    }
    if (!session || !Array.isArray(session.tabs)) return;
    const paths = session.tabs.filter((p) => typeof p === 'string' && p);
    const active = typeof session.active === 'string' ? session.active : null;
    const split = typeof session.split === 'string' && session.split ? session.split : null;
    for (const p of paths) {
      if (!documentTabs.some((t) => samePath(t.path, p))) {
        documentTabs.push({ path: p, editorState: null });
      }
    }
    const studio = getStudio();
    if (studio && active && paths.some((p) => samePath(p, active))) {
      try {
        const r = await studio.readFile(active);
        openDiskDoc(r);
        if (
          split &&
          !samePath(split, active) &&
          paths.some((p) => samePath(p, split)) &&
          typeof onRestoreSplit === 'function'
        ) {
          await onRestoreSplit(split);
        }
        return;
      } catch {
        /* 活动文件已不存在：保留其余标签，正文留空 */
      }
    }
    syncTabs();
  }

  function remapDocumentTabs(source, dest) {
    const norm = (p) => String(p).toLowerCase();
    for (const tab of documentTabs) {
      if (samePath(tab.path, source)) tab.path = dest;
      else if (norm(tab.path).startsWith(norm(source) + '\\') || norm(tab.path).startsWith(norm(source) + '/')) {
        tab.path = dest + tab.path.slice(source.length);
      }
    }
  }

  function removeDocumentTabsUnder(source) {
    const norm = (p) => String(p).toLowerCase();
    for (let i = documentTabs.length - 1; i >= 0; i--) {
      const p = norm(documentTabs[i].path);
      if (samePath(documentTabs[i].path, source) || p.startsWith(norm(source) + '\\') || p.startsWith(norm(source) + '/')) {
        documentTabs.splice(i, 1);
      }
    }
  }

  function snapshotDocumentTab(oldPath = state.path) {
    if (!tabsEnabled || !oldPath) return;
    let tab = documentTabs.find((item) => samePath(item.path, oldPath));
    if (!tab) {
      tab = { path: oldPath, editorState: null };
      documentTabs.push(tab);
    }
    if (samePath(oldPath, state.path)) tab.editorState = view.state;
  }

  function findCachedTab(pathOrName, text) {
    return (
      documentTabs.find(
        (item) => samePath(item.path, pathOrName) && item.editorState?.doc.toString() === text,
      ) || null
    );
  }

  function replaceTabPath(oldPath, newPath) {
    if (!tabsEnabled) return;
    if (oldPath && !samePath(oldPath, newPath)) {
      const oldIndex = documentTabs.findIndex((item) => samePath(item.path, oldPath));
      if (oldIndex >= 0) documentTabs.splice(oldIndex, 1);
    }
    snapshotDocumentTab(newPath);
  }

  function ensureTab(path) {
    if (!tabsEnabled || !path) return;
    if (!documentTabs.some((item) => samePath(item.path, path))) {
      documentTabs.push({ path, editorState: null });
    }
    syncTabs();
  }

  async function openTab(path) {
    if (samePath(path, state.path)) {
      onFocusPane?.('primary');
      return;
    }
    const splitPath = getSplitPath?.();
    if (splitPath && samePath(path, splitPath)) {
      onFocusPane?.('split');
      return;
    }
    if (!(await settleCurrentDocument())) return;
    const studio = getStudio();
    if (!studio?.readFile) return;
    try {
      const r = await studio.readFile(path);
      openDiskDoc(r);
    } catch (err) {
      flash('打开标签失败：' + (err?.message || err));
    }
  }

  async function closeTab(path) {
    const tab = documentTabs.find((item) => samePath(item.path, path));
    if (!tab) return;
    const splitPath = getSplitPath?.();
    if (splitPath && samePath(tab.path, splitPath)) {
      if (!(await onBeforeCloseSplit(tab.path))) return;
      const idx = documentTabs.indexOf(tab);
      if (idx >= 0) documentTabs.splice(idx, 1);
      syncTabs();
      return;
    }
    const active = samePath(tab.path, state.path);
    if (active && !(await settleCurrentDocument())) return;
    const index = documentTabs.indexOf(tab);
    documentTabs.splice(index, 1);
    if (active) {
      const next = documentTabs[Math.max(0, index - 1)];
      if (next && splitPath && samePath(next.path, splitPath) && typeof onPromoteSplit === 'function') {
        if (await onPromoteSplit(next.path)) return;
      }
      const studio = getStudio();
      if (next && studio?.readFile) {
        try {
          const r = await studio.readFile(next.path);
          openDiskDoc(r, { snapshotOld: false });
          return;
        } catch {
          /* 文件已被外部删除时退回空白文档 */
        }
      }
      loadDoc('', null, { snapshotOld: false });
    } else {
      syncTabs();
    }
  }

  /** 关闭除指定标签外的其他全部标签；若当前活动标签被关闭，则切到目标标签。 */
  async function closeOtherTabs(keepPath) {
    const target = documentTabs.find((item) => samePath(item.path, keepPath));
    if (!target) return;
    const splitPath = getSplitPath?.();
    const keepingActive = samePath(target.path, state.path);
    const keepingSplit = !!splitPath && samePath(target.path, splitPath);
    if (splitPath && !keepingSplit) {
      if (!(await onBeforeCloseSplit(splitPath))) return;
    }
    if (!keepingActive && !(await settleCurrentDocument())) return;
    documentTabs.splice(0, documentTabs.length, target);
    if (!keepingActive) {
      if (keepingSplit && typeof onPromoteSplit === 'function') {
        if (await onPromoteSplit(target.path)) return;
      }
      const studio = getStudio();
      if (studio?.readFile) {
        try {
          const r = await studio.readFile(target.path);
          openDiskDoc(r, { snapshotOld: false });
          return;
        } catch (err) {
          flash('打开标签失败：' + (err?.message || err));
        }
      }
    }
    syncTabs();
  }

  /** 关闭指定标签右侧的所有标签；若活动标签位于右侧，则切回目标标签。 */
  async function closeTabsToRight(pivotPath) {
    const idx = documentTabs.findIndex((item) => samePath(item.path, pivotPath));
    if (idx < 0 || idx >= documentTabs.length - 1) return;
    const removed = documentTabs.slice(idx + 1);
    const splitPath = getSplitPath?.();
    const splitRemoved = !!splitPath && removed.some((t) => samePath(t.path, splitPath));
    if (splitRemoved && !(await onBeforeCloseSplit(splitPath))) return;
    const activeRemoved = removed.some((t) => samePath(t.path, state.path));
    if (activeRemoved && !(await settleCurrentDocument())) return;
    documentTabs.splice(idx + 1);
    if (activeRemoved) {
      const nextTarget = documentTabs[idx];
      if (nextTarget && splitPath && samePath(nextTarget.path, splitPath) && typeof onPromoteSplit === 'function') {
        if (await onPromoteSplit(nextTarget.path)) return;
      }
      const studio = getStudio();
      if (studio?.readFile) {
        try {
          const r = await studio.readFile(nextTarget.path);
          openDiskDoc(r, { snapshotOld: false });
          return;
        } catch (err) {
          flash('打开标签失败：' + (err?.message || err));
        }
      }
      loadDoc('', null, { snapshotOld: false });
      return;
    }
    syncTabs();
  }

  return {
    documentTabs,
    persistSession,
    restoreSession,
    remapDocumentTabs,
    removeDocumentTabsUnder,
    syncTabs,
    ensureTab,
    snapshotDocumentTab,
    findCachedTab,
    replaceTabPath,
    openTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
  };
}
