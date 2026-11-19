/** 不依赖第三方库，把 Markdown 收成 Word 能打开的 docx（ZIP 存储、不压缩）。 */
import { escapeXml, frontMatterEnd, splitMarkdownLines } from './markdown-source.js';

const encoder = new TextEncoder();

function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralBlob = concat(centrals);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBlob.length),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, centralBlob, end]);
}

function para(text, size, bold) {
  const rPr = `<w:rPr>${bold ? '<w:b/>' : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>`;
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

function markdownToDocumentXml(md) {
  const lines = splitMarkdownLines(md);
  const body = [];
  let i = frontMatterEnd(lines);
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const size = [40, 36, 32, 28, 26, 24][heading[1].length - 1];
      body.push(para(heading[2], size, true));
      continue;
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      const mark = line.trim()[0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s{0,3}\\' + mark + '{3,}').test(lines[i])) buf.push(lines[i++]);
      body.push(para(buf.join('\n'), 20, false));
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    body.push(para(item ? '• ' + item[1] : line.replace(/^\s{0,3}>\s?/, ''), 22, false));
  }
  if (!body.length) body.push(para('', 22, false));
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

export function markdownToDocx(md) {
  const documentXml = markdownToDocumentXml(md);
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: documentXml },
  ]);
}
