/**
 * 草稿快照、多文档草稿恢复面板与退出前兜底保存（从 runtime.js 抽离）。
 */
import {
  clearAllDraftEntries,
  draftPreviewText,
  loadDraftList,
  removeDraftEntry,
  upsertDraftEntry,
} from './draft-recovery.js';
import { DRAFT_KEY } from './storage-keys.js';

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function createDraftUI({
  state,
  getView,
  loadDoc,
  setDirty,
  openSheet,
  closeSettings,
  flash,
  countWords,
}) {
  let draftTimer = null;
  // 启动初始化会把当前空白文档标成干净；先把上次草稿读出来，避免初始化误清掉。
  const STARTUP_DRAFT = (() => {
    try {
      return localStorage.getItem(DRAFT_KEY);
    } catch {
      return null;
    }
  })();

  function clearDraft() {
    clearTimeout(draftTimer);
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* 存储不可用时，内存编辑不受影响 */
    }
    removeDraftEntry(state.path);
  }

  function writeDraft() {
    clearTimeout(draftTimer);
    if (!state.dirty) return;
    const view = getView();
    if (!view) return;
    const snapshot = {
      path: state.path,
      content: view.state.doc.toString(),
      eol: state.eol,
      bom: state.bom,
      encoding: state.encoding,
      updatedAt: Date.now(),
    };
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot));
    } catch {
      /* 配额不足或隐私模式下退化为普通未保存提示 */
    }
    upsertDraftEntry(snapshot);
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    if (state.dirty) draftTimer = setTimeout(writeDraft, 700);
  }

  function restoreDraftItem(draft) {
    if (!draft || typeof draft.content !== 'string') return;
    loadDoc(draft.content, typeof draft.path === 'string' ? draft.path : null);
    if (draft.eol === '\r\n' || draft.eol === '\n') state.eol = draft.eol;
    if (typeof draft.bom === 'boolean') state.bom = draft.bom;
    if (typeof draft.encoding === 'string' && draft.encoding) state.encoding = draft.encoding;
    setDirty(true);
    writeDraft();
    flash(`已恢复未保存草稿：${draft.name || '未命名.md'}`);
  }

  function openDraftRecoveryModal() {
    const list = loadDraftList();
    if (!list.length) {
      openSheet(
        '未保存草稿恢复',
        `<p class="settings-note">当前没有可恢复的未保存草稿。</p>` +
          `<div class="settings-actions"><button type="button" id="draft-close" class="settings-btn">关闭</button></div>`,
      );
      document.getElementById('draft-close')?.addEventListener('click', closeSettings);
      return;
    }
    const rows = list
      .map((d, idx) => {
        const timeStr = new Date(d.updatedAt).toLocaleString();
        const words = countWords(d.content).toLocaleString();
        return (
          `<div class="draft-item" data-idx="${idx}">` +
          `<div class="draft-head"><b>${escHtml(d.name)}</b><span class="draft-meta">${words} 字 · ${escHtml(timeStr)}</span></div>` +
          (d.path ? `<div class="draft-path" title="${escHtml(d.path)}">${escHtml(d.path)}</div>` : '') +
          `<div class="draft-preview">${escHtml(draftPreviewText(d.content))}</div>` +
          `<div class="draft-actions">` +
          `<button type="button" class="settings-btn draft-restore" data-idx="${idx}">恢复此草稿</button>` +
          `<button type="button" class="settings-btn draft-delete" data-idx="${idx}">删除</button>` +
          `</div></div>`
        );
      })
      .join('');
    openSheet(
      `未保存草稿恢复（${list.length}）`,
      `<p class="settings-note">按文档自动保留最近未保存快照，可随时选择恢复或清理。</p>` +
        `<div class="draft-list">${rows}</div>` +
        `<div class="settings-actions">` +
        `<button type="button" id="draft-clear-all" class="settings-btn">清空全部草稿</button>` +
        `<button type="button" id="draft-close" class="settings-btn">关闭</button>` +
        `</div>`,
    );
    const body = document.getElementById('settings-body');
    body?.querySelectorAll('.draft-restore').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = list[Number(btn.dataset.idx)];
        closeSettings();
        if (item) restoreDraftItem(item);
      });
    });
    body?.querySelectorAll('.draft-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = list[Number(btn.dataset.idx)];
        if (item) removeDraftEntry(item.id);
        openDraftRecoveryModal();
      });
    });
    document.getElementById('draft-clear-all')?.addEventListener('click', () => {
      clearAllDraftEntries();
      closeSettings();
      flash('已清空所有未保存草稿');
    });
    document.getElementById('draft-close')?.addEventListener('click', closeSettings);
  }

  async function offerDraftRecovery() {
    const list = loadDraftList();
    if (list.length > 1) {
      openDraftRecoveryModal();
      return;
    }
    let draft = list[0] || null;
    if (!draft && STARTUP_DRAFT) {
      try {
        draft = JSON.parse(STARTUP_DRAFT);
      } catch {
        clearDraft();
        return;
      }
    }
    if (!draft || typeof draft.content !== 'string') return;
    const restore = window.studio?.confirm
      ? await window.studio.confirm(`检测到上次未保存的草稿（${draft.name || '未命名.md'}），是否恢复？`)
      : window.confirm(`检测到上次未保存的草稿（${draft.name || '未命名.md'}），是否恢复？`);
    if (!restore) {
      removeDraftEntry(draft.id || draft.path);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    restoreDraftItem(draft);
  }

  window.addEventListener('beforeunload', () => {
    if (state.dirty) writeDraft();
  });

  return {
    clearDraft,
    writeDraft,
    scheduleDraft,
    openDraftRecoveryModal,
    offerDraftRecovery,
  };
}
