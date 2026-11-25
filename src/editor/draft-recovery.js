/**
 * 多文档未保存草稿恢复列表（纯数据操作 + 容错持久化）：
 * - 最多保留最近 12 份不同文档的未保存快照，按路径（或未命名 ID）去重更新
 * - 兼容读取旧版单条 `DRAFT_KEY` 并平滑并入列表
 * - 存储配额紧张时自动淘汰最旧条目，避免长文写入失败
 */
import { DRAFT_KEY, DRAFT_LIST_KEY } from './storage-keys.js';

export const MAX_DRAFTS = 12;

function getStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function draftIdForPath(path) {
  return path ? 'file:' + String(path).replace(/\\/g, '/').toLowerCase() : 'untitled';
}

export function draftPreviewText(content, maxLen = 84) {
  const flat = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '（空白草稿）';
  return flat.length > maxLen ? flat.slice(0, maxLen) + '…' : flat;
}

export function loadDraftList(storage) {
  const store = getStorage(storage);
  if (!store) return [];
  const items = [];
  const seen = new Set();

  try {
    const raw = store.getItem(DRAFT_LIST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const it of parsed) {
          if (!it || typeof it.content !== 'string') continue;
          const id = it.id || draftIdForPath(it.path);
          if (seen.has(id)) continue;
          seen.add(id);
          items.push({
            id,
            path: typeof it.path === 'string' ? it.path : null,
            name: it.name || (it.path ? String(it.path).split(/[\\/]/).pop() : '未命名.md'),
            content: it.content,
            eol: it.eol === '\r\n' ? '\r\n' : '\n',
            bom: !!it.bom,
            encoding: typeof it.encoding === 'string' && it.encoding ? it.encoding : 'utf-8',
            updatedAt: Number(it.updatedAt) || Date.now(),
          });
        }
      }
    }
  } catch {
    /* 损坏数据忽略 */
  }

  // 兼容旧版单条草稿键
  try {
    const legacy = JSON.parse(store.getItem(DRAFT_KEY) || 'null');
    if (legacy && typeof legacy.content === 'string') {
      const id = draftIdForPath(legacy.path);
      if (!seen.has(id)) {
        seen.add(id);
        items.push({
          id,
          path: typeof legacy.path === 'string' ? legacy.path : null,
          name: legacy.path ? String(legacy.path).split(/[\\/]/).pop() : '未命名.md',
          content: legacy.content,
          eol: legacy.eol === '\r\n' ? '\r\n' : '\n',
          bom: !!legacy.bom,
          encoding: typeof legacy.encoding === 'string' && legacy.encoding ? legacy.encoding : 'utf-8',
          updatedAt: Number(legacy.updatedAt) || Date.now(),
        });
      }
    }
  } catch {
    /* ignore */
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items.slice(0, MAX_DRAFTS);
}

function persistDraftList(items, storage) {
  const store = getStorage(storage);
  if (!store) return false;
  let list = items.slice(0, MAX_DRAFTS);
  while (list.length > 0) {
    try {
      store.setItem(DRAFT_LIST_KEY, JSON.stringify(list));
      return true;
    } catch {
      // 配额不足时淘汰最旧的一条重试
      list = list.slice(0, -1);
    }
  }
  try {
    store.removeItem(DRAFT_LIST_KEY);
  } catch {
    /* ignore */
  }
  return false;
}

export function upsertDraftEntry(entry, storage) {
  if (!entry || typeof entry.content !== 'string') return [];
  const id = entry.id || draftIdForPath(entry.path);
  const next = {
    id,
    path: typeof entry.path === 'string' ? entry.path : null,
    name: entry.name || (entry.path ? String(entry.path).split(/[\\/]/).pop() : '未命名.md'),
    content: entry.content,
    eol: entry.eol === '\r\n' ? '\r\n' : '\n',
    bom: !!entry.bom,
    encoding: typeof entry.encoding === 'string' && entry.encoding ? entry.encoding : 'utf-8',
    updatedAt: Number(entry.updatedAt) || Date.now(),
  };
  const existing = loadDraftList(storage).filter((it) => it.id !== id);
  const merged = [next, ...existing].slice(0, MAX_DRAFTS);
  persistDraftList(merged, storage);
  return merged;
}

export function removeDraftEntry(idOrPath, storage) {
  const targetId = String(idOrPath || '').startsWith('file:') || idOrPath === 'untitled'
    ? idOrPath
    : draftIdForPath(idOrPath);
  const remaining = loadDraftList(storage).filter((it) => it.id !== targetId);
  persistDraftList(remaining, storage);
  return remaining;
}

export function clearAllDraftEntries(storage) {
  const store = getStorage(storage);
  if (!store) return;
  try {
    store.removeItem(DRAFT_LIST_KEY);
    store.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
