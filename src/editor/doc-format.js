/**
 * 文档磁盘格式：换行风格（LF/CRLF）与 BOM 的检测和还原。
 * 纯函数，不持有状态；调用方把检测结果存进自己的 state，写盘时再传回来。
 */

/** 统一成 LF 并保证末尾有一个空行（CM 文档约定）。 */
export function withTrailingBlank(content) {
  const text = String(content ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (!text || text.endsWith("\n")) return text;
  return text + "\n";
}

/** 载入时记录原文件的换行风格（按多数）与 BOM；新文档默认 LF、无 BOM。 */
export function detectDocFormat(raw) {
  const text = String(raw ?? "");
  const bom = text.startsWith("\uFEFF");
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { bom, eol: crlf > lf ? "\r\n" : "\n" };
}

/** 写盘前的最后一步：把内存里的 LF 正文还原成原文件的换行风格与 BOM。 */
export function serializeForDisk(content, { eol = "\n", bom = false } = {}) {
  const text = eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
  return bom ? "\uFEFF" + text : text;
}