/** 文件列表的相对时间与摘要（与原 Electron 版同一套展示规则）。 */
export function relTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = 60000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() === new Date().getFullYear() ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

export function fileSnippet(raw, plainInline) {
  if (!raw) return '';
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^(`{3,}|~{3,})/.test(t)) continue;
    if (/^!\[/.test(t)) continue;
    if (/^\|/.test(t)) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) continue;
    const clean = plainInline(
      t.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^>\s*/, '').replace(/^([-*+]|\d+[.)])\s+/, ''),
    );
    if (clean) return clean;
  }
  return '';
}

export const stripMdExt = (name) => name.replace(/\.(md|markdown|txt)$/i, '');
