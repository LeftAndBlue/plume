import { renderMarkdown } from './markdown-export.js';
import { zipStore } from './docx-export.js';
import { escapeXml, frontMatterEnd, splitMarkdownLines } from './markdown-source.js';

function eachBlock(md, emit) {
  const lines = splitMarkdownLines(md);
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      emit({ type: 'h', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      const mark = line.trim()[0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s{0,3}\\' + mark + '{3,}').test(lines[i])) buf.push(lines[i++]);
      emit({ type: 'code', text: buf.join('\n') });
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      emit({ type: 'hr' });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote) {
      emit({ type: 'quote', text: quote[1] });
      continue;
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      emit({ type: 'li', text: item[2] });
      continue;
    }
    emit({ type: 'p', text: line });
  }
}

function rtfText(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (c < 128) out += ch;
    else out += '\\u' + (c > 32767 ? c - 65536 : c) + '?';
  }
  return out;
}

function texText(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function inlineTex(s) {
  return texText(s)
    .replace(/`([^`]+)`/g, '\\texttt{$1}')
    .replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}')
    .replace(/\*([^*]+)\*/g, '\\textit{$1}');
}

export function markdownToRtf(md) {
  const parts = ['{\\rtf1\\ansi\\ansicpg65001\\deff0{\\fonttbl{\\f0\\fnil SimSun;}{\\f1\\fmodern Consolas;}}\\viewkind4\\uc1\\pard\\lang2052\\f0\\fs24 '];
  eachBlock(md, (block) => {
    if (block.type === 'h') parts.push('\\b\\fs' + (36 - block.level * 2) + ' ' + rtfText(block.text) + '\\b0\\fs24\\par ');
    else if (block.type === 'code') parts.push('\\f1 ' + rtfText(block.text).replace(/\n/g, '\\line ') + '\\f0\\par ');
    else if (block.type === 'quote') parts.push('\\i ' + rtfText(block.text) + '\\i0\\par ');
    else if (block.type === 'li') parts.push('\\bullet  ' + rtfText(block.text) + '\\par ');
    else if (block.type === 'hr') parts.push('\\par ---\\par ');
    else parts.push(rtfText(block.text) + '\\par ');
  });
  parts.push('}');
  return parts.join('');
}

export function markdownToLatex(md) {
  const parts = ['\\documentclass[UTF8]{ctexart}', '\\begin{document}', ''];
  eachBlock(md, (block) => {
    if (block.type === 'h') {
      const cmd = ['section', 'subsection', 'subsubsection', 'paragraph', 'paragraph', 'paragraph'][block.level - 1];
      parts.push('\\' + cmd + '{' + inlineTex(block.text) + '}');
    } else if (block.type === 'code') {
      parts.push('\\begin{verbatim}', block.text, '\\end{verbatim}');
    } else if (block.type === 'quote') parts.push('\\begin{quote}' + inlineTex(block.text) + '\\end{quote}');
    else if (block.type === 'li') parts.push('\\begin{itemize}\\item ' + inlineTex(block.text) + '\\end{itemize}');
    else if (block.type === 'hr') parts.push('\\noindent\\rule{\\textwidth}{0.4pt}');
    else parts.push(inlineTex(block.text), '');
  });
  parts.push('\\end{document}', '');
  return parts.join('\n');
}

export function markdownToEpub(md, title = '未命名') {
  const xhtml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
    escapeXml(title) +
    '</title></head><body>' +
    renderMarkdown(md) +
    '</body></html>';
  const opf =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">' +
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' +
    escapeXml(title) +
    '</dc:title><dc:language>zh-CN</dc:language><dc:identifier id="bid">markline</dc:identifier></metadata>' +
    '<manifest><item id="chap" href="chap.xhtml" media-type="application/xhtml+xml"/></manifest>' +
    '<spine><itemref idref="chap"/></spine></package>';
  const container =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  return zipStore([
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: container },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/chap.xhtml', data: xhtml },
  ]);
}
