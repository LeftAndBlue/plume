import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEMES, DARK_THEME_IDS } from '../src/editor/theme-catalog.js';
import { slugify } from '../src/editor/slugify.js';
import {
  buildTableMarkdown,
  insertTableRow,
  deleteTableCol,
  setAlign,
} from '../src/editor/table-model.js';
import {
  EMOJI_LIST,
  SLASH_COMMANDS,
  computeHeadingFoldLines,
  computeWordGoalProgress,
  countParagraphs,
  matchExactEmojiShortcode,
  matchQuickTrigger,
  panguSpacing,
  resolveImageFolder,
  sanitizeInlineStyle,
  scanDetailsBlocks,
  scanStyledInlineHtml,
  computeBlockWindow,
  filterPaletteCommands,
  shouldRefreshBlockWindow,
  updateImageWidthAttr,
} from '../src/editor/extrasText.js';
import {
  clampFontSize,
  createJumpHistory,
  stepFontSize,
} from '../src/editor/jump-history.js';
import { styleWeChatHtml } from '../src/editor/wechat-html.js';
import { createTabsManager } from '../src/editor/tabs.js';
import {
  clearAllDraftEntries,
  draftPreviewText,
  loadDraftList,
  removeDraftEntry,
  upsertDraftEntry,
} from '../src/editor/draft-recovery.js';
import { DRAFT_KEY } from '../src/editor/storage-keys.js';
import { declaredShortcuts, normAccel, shortcutGroups } from '../src/editor/shortcuts.js';
import {
  codeBlockEnter,
  continueList,
  continueQuote,
  handleShiftTab,
  handleTab,
  indentCodeBlock,
  indentList,
  normalizeEmptyTaskListInput,
  outdentLength,
  outdentSoftTabOnBackspace,
  softNewline,
  tabOutOfPair,
} from '../src/editor/typing-ergonomics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function createMockStorage(quotaChars = Infinity) {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const str = String(v);
      if (str.length > quotaChars) throw new Error('QuotaExceededError');
      map.set(k, str);
    },
    removeItem: (k) => map.delete(k),
  };
}

test('theme-catalog 与 styles/themes 和 index.css 完全同步', () => {
  const indexCss = fs.readFileSync(path.join(ROOT, 'src/editor/styles/index.css'), 'utf-8');
  const whiteCss = fs.readFileSync(path.join(ROOT, 'src/editor/styles/themes/white.css'), 'utf-8');
  const requiredVars = new Set(whiteCss.match(/--[a-z0-9-]+(?=\s*:)/g) || []);
  const ids = new Set();

  for (const theme of THEMES) {
    assert.ok(!ids.has(theme.id), `重复主题 id: ${theme.id}`);
    ids.add(theme.id);
    assert.equal(DARK_THEME_IDS.has(theme.id), !!theme.dark, `深浅标记不一致: ${theme.id}`);
    assert.ok(
      indexCss.includes(`@import "./themes/${theme.id}.css";`),
      `index.css 缺少导入: ${theme.id}.css`
    );
    const cssPath = path.join(ROOT, `src/editor/styles/themes/${theme.id}.css`);
    assert.ok(fs.existsSync(cssPath), `缺少主题文件: ${cssPath}`);
    const css = fs.readFileSync(cssPath, 'utf-8');
    const defined = new Set(css.match(/--[a-z0-9-]+(?=\s*:)/g) || []);
    for (const v of requiredVars) {
      assert.ok(defined.has(v), `主题 ${theme.id} 缺少变量 ${v}`);
    }
  }
});

test('slugify 支持中英文与重名编号', () => {
  const used = new Set();
  assert.equal(slugify('Hello World!', used), 'Hello-World');
  assert.equal(slugify('Hello World!', used), 'Hello-World-2');
  assert.equal(slugify('第一章：光标系统优化', used), '第一章光标系统优化');
});

test('table-model 构建、插行、对齐与删列正常', () => {
  const md = buildTableMarkdown(2, 2);
  assert.equal(md.split('\n').length, 4);
  assert.ok(md.includes('---'));
  const rows = [
    ['A', 'B'],
    ['---', '---'],
    ['1', '2'],
  ];
  const withRow = insertTableRow(rows, 1) || rows;
  assert.equal(withRow.length, 4);
  setAlign(withRow, 1, 'right');
  assert.equal(withRow[1][1], '---:');
  const oneCol = deleteTableCol(withRow, 0) || withRow;
  assert.equal(oneCol[0].length, 1);
});

test('resolveImageFolder 支持 ${filename}.assets 且对未保存文档回退 assets', () => {
  assert.equal(resolveImageFolder('${filename}.assets', '/docs/架构设计.md'), '架构设计.assets');
  assert.equal(resolveImageFolder('img/${filename}', 'C:\\notes\\demo.md'), 'img/demo');
  assert.equal(resolveImageFolder('${filename}.assets', ''), 'assets');
  assert.equal(resolveImageFolder('../etc/passwd', '/docs/a.md'), 'etc/passwd');
});

test('updateImageWidthAttr 正确写入与更新图片宽度属性并保留其他属性', () => {
  assert.equal(updateImageWidthAttr('![图](a.png)', 480), '![图](a.png){width=480}');
  assert.equal(
    updateImageWidthAttr('![图](a.png){width=200 align=center}', 640),
    '![图](a.png){width=640 align=center}'
  );
  assert.equal(
    updateImageWidthAttr('![图](a.png){align=right}', 320),
    '![图](a.png){width=320 align=right}'
  );
  assert.equal(updateImageWidthAttr('![图](a.png)', 10), '![图](a.png){width=40}');
});

test('panguSpacing 自动补齐中英文空格并跳过代码块、行内代码、链接、公式与 HTML 标签', () => {
  const input = [
    '使用Plume编辑Markdown文档第1版',
    '跳过`code测试`和[链接Test](https://example.com/中文Test)以及$E=mc^2$公式',
    '<span style="color:red">内联HTML标签Text测试</span>',
    '```js',
    'const s = "代码里不改ABC中文";',
    '```',
  ].join('\n');
  const out = panguSpacing(input);
  assert.ok(out.includes('使用 Plume 编辑 Markdown 文档第 1 版'));
  assert.ok(out.includes('`code测试`'));
  assert.ok(out.includes('[链接Test](https://example.com/中文Test)'));
  assert.ok(out.includes('<span style="color:red">内联 HTML 标签 Text 测试</span>'));
  assert.ok(out.includes('const s = "代码里不改ABC中文";'));
});

test('countParagraphs 与 computeWordGoalProgress 正确统计段落和单篇字数目标进度', () => {
  assert.equal(countParagraphs('第一段\n续行\n\n第二段\n\n\n第三段'), 3);
  assert.equal(countParagraphs('   '), 0);

  const p1 = computeWordGoalProgress(500, 2000);
  assert.equal(p1.percent, 25);
  assert.equal(p1.remaining, 1500);
  assert.equal(p1.reached, false);

  const p2 = computeWordGoalProgress(2300, 2000);
  assert.equal(p2.percent, 100);
  assert.equal(p2.remaining, 0);
  assert.equal(p2.reached, true);
});

test('matchQuickTrigger 与 matchExactEmojiShortcode 支持 100+ Emoji、自动替换与 /table 命令联动', () => {
  assert.ok(EMOJI_LIST.length >= 100);
  const slash = matchQuickTrigger('/mer', 10, 4);
  assert.equal(slash.kind, 'slash');
  assert.equal(slash.from, 10);
  assert.equal(slash.items[0].id, 'mermaid');

  const tbl = SLASH_COMMANDS.find((c) => c.id === 'table');
  assert.equal(tbl?.command, 'insert-table');

  const emoji = matchQuickTrigger('你好 :roc', 0, 7);
  assert.equal(emoji.kind, 'emoji');
  assert.equal(emoji.from, 3);
  assert.equal(emoji.items[0].emoji, '🚀');

  const exact = matchExactEmojiShortcode('完成啦 :tada:', 0, 10);
  assert.ok(exact);
  assert.equal(exact.emoji, '🎉');
  assert.equal(exact.from, 4);
  assert.equal(exact.to, 10);
});

test('内联 HTML 白名单样式过滤、<center>/<span style> 扫描与 <details> 折叠块扫描', () => {
  assert.equal(
    sanitizeInlineStyle('color: #e11d48; background: url(javascript:alert(1)); font-weight: bold'),
    'color: #e11d48; font-weight: bold'
  );
  const inline = scanStyledInlineHtml('<center>居中</center> 与 <span style="color: red">红字</span>');
  assert.equal(inline.length, 2);
  assert.equal(inline[0].tag, 'center');
  assert.equal(inline[1].tag, 'span');
  assert.equal(inline[1].style, 'color: red');

  const doc = [
    '<details>',
    '<summary>展开说明</summary>',
    '',
    '这里是折叠正文',
    '</details>',
    '```html',
    '<details><summary>代码块内忽略</summary>x</details>',
    '```',
  ].join('\n');
  const blocks = scanDetailsBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].summary, '展开说明');
  assert.equal(blocks[0].body, '这里是折叠正文');
});

test('computeHeadingFoldLines 正确计算 H1–H3 折叠边界并跳过代码块与 H4+', () => {
  const lines = [
    '# 第一章',
    '概述段落',
    '## 1.1 小节',
    '内容 A',
    '```md',
    '# 代码里的假标题',
    '```',
    '',
    '## 1.2 小节',
    '内容 B',
    '#### 四级标题不折叠',
    '内容 C',
    '# 第二章',
    '尾段',
  ];
  // H1 折叠到第 12 行（跳过第二章前的全部子章节）
  assert.deepEqual(computeHeadingFoldLines(lines, 0, 3), { startLine: 1, endLine: 12 });
  // H2 (1.1) 折叠到第 7 行（自动去掉第 8 行空行，且不因代码块内 # 提前截断）
  assert.deepEqual(computeHeadingFoldLines(lines, 2, 3), { startLine: 3, endLine: 7 });
  // H4 不在 H1–H3 折叠范围
  assert.equal(computeHeadingFoldLines(lines, 10, 3), null);
});

test('draft-recovery 支持多文档草稿列表、旧单条迁移、删除与超容裁剪', () => {
  const store = createMockStorage();
  store.setItem(
    DRAFT_KEY,
    JSON.stringify({ path: 'C:\\notes\\old.md', content: '旧版单条草稿', updatedAt: 1000 })
  );
  upsertDraftEntry({ path: 'C:\\notes\\a.md', content: '文档 A 内容', updatedAt: 2000 }, store);
  upsertDraftEntry({ path: 'C:\\notes\\b.md', content: '文档 B 内容', updatedAt: 3000 }, store);
  upsertDraftEntry({ path: 'C:\\notes\\a.md', content: '文档 A 更新后', updatedAt: 4000 }, store);

  const list = loadDraftList(store);
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'a.md');
  assert.equal(list[0].content, '文档 A 更新后');
  assert.equal(draftPreviewText('  第一行\n\n第二行  '), '第一行 第二行');

  removeDraftEntry('C:\\notes\\b.md', store);
  assert.equal(loadDraftList(store).length, 2);

  clearAllDraftEntries(store);
  assert.equal(loadDraftList(store).length, 0);
});

/* ---------------- 编辑器盲打直觉（Tab / Enter / Space / Backspace） ---------------- */

function makeMockDoc(text) {
  const rawLines = text.split('\n');
  const lines = [];
  let offset = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const t = rawLines[i];
    lines.push({ number: i + 1, from: offset, to: offset + t.length, text: t });
    offset += t.length + 1;
  }
  return {
    length: text.length,
    lines: lines.length,
    toString: () => text,
    sliceString: (from, to = text.length) => text.slice(Math.max(0, from), Math.max(0, to)),
    line: (n) => lines[n - 1],
    lineAt: (pos) => {
      for (const l of lines) {
        if (pos >= l.from && pos <= l.to) return l;
      }
      return lines[lines.length - 1];
    },
  };
}

function makeMockView(docText, anchor, head = anchor) {
  let text = docText;
  let range = {
    anchor,
    head,
    from: Math.min(anchor, head),
    to: Math.max(anchor, head),
    empty: anchor === head,
  };
  const view = {
    state: {
      doc: makeMockDoc(text),
      selection: { main: range, ranges: [range] },
    },
    dispatch(spec) {
      let changes = [];
      if (spec.changes) {
        changes = Array.isArray(spec.changes) ? spec.changes : [spec.changes];
      }
      // 按 from 倒序应用变更并映射光标
      let nextAnchor = range.anchor;
      let nextHead = range.head;
      const sorted = [...changes].sort((a, b) => b.from - a.from);
      for (const ch of sorted) {
        const from = ch.from;
        const to = ch.to ?? ch.from;
        const ins = ch.insert ?? '';
        const delta = ins.length - (to - from);
        text = text.slice(0, from) + ins + text.slice(to);
        if (nextAnchor >= to) nextAnchor += delta;
        else if (nextAnchor > from) nextAnchor = from + ins.length;
        if (nextHead >= to) nextHead += delta;
        else if (nextHead > from) nextHead = from + ins.length;
      }
      if (spec.selection) {
        nextAnchor = spec.selection.anchor;
        nextHead = spec.selection.head ?? spec.selection.anchor;
      }
      range = {
        anchor: nextAnchor,
        head: nextHead,
        from: Math.min(nextAnchor, nextHead),
        to: Math.max(nextAnchor, nextHead),
        empty: nextAnchor === nextHead,
      };
      view.state = {
        doc: makeMockDoc(text),
        selection: { main: range, ranges: [range] },
      };
    },
    get text() {
      return text;
    },
    get pos() {
      return range.head;
    },
  };
  return view;
}

test('Tab 在普通正文不插入硬 \\t，在代码块内插入软空格并支持 Shift+Tab 反缩进', () => {
  // 普通正文行首按 Tab 不应插 \t 触发缩进代码块
  const vPara = makeMockView('普通段落正文', 0);
  assert.equal(handleTab(vPara), true);
  assert.equal(vPara.text, '普通段落正文');

  // 代码块内按 Tab 插入 2 空格，Shift+Tab 反缩进 2 空格
  const code = '```js\nconst a = 1;\n```';
  const lineStart = code.indexOf('const');
  const vCode = makeMockView(code, lineStart);
  assert.equal(handleTab(vCode), true);
  assert.equal(vCode.text, '```js\n  const a = 1;\n```');
  assert.equal(vCode.pos, lineStart + 2);

  assert.equal(handleShiftTab(vCode), true);
  assert.equal(vCode.text, '```js\nconst a = 1;\n```');

  // 代码块内支持自定义 4 空格缩进与多行批量缩进
  const multi = '```js\na();\nb();\n```';
  const vMulti = makeMockView(multi, multi.indexOf('a()'), multi.indexOf('b();') + 4);
  assert.equal(indentCodeBlock(vMulti, 1, 4), true);
  assert.equal(vMulti.text, '```js\n    a();\n    b();\n```');
});

test('引用块内列表支持 Tab / Shift+Tab 调层级且不破坏 > 前缀', () => {
  const v = makeMockView('> - item', 8);
  assert.equal(handleTab(v), true);
  assert.equal(v.text, '>   - item');
  assert.equal(handleShiftTab(v), true);
  assert.equal(v.text, '> - item');

  const vNested = makeMockView('> > - item', 10);
  assert.equal(handleTab(vNested), true);
  assert.equal(vNested.text, '> >   - item');
});

test('混用 \\t 与空格的列表 Shift+Tab 只退一级，不一次删过头', () => {
  assert.equal(outdentLength('\t  ', 2), 1);
  assert.equal(outdentLength(' \t', 2), 1);
  assert.equal(outdentLength('    ', 2), 2);

  const v = makeMockView('\t  - item', 9);
  assert.equal(indentList(v, -1), true);
  assert.equal(v.text, '  - item');
  assert.equal(indentList(v, -1), true);
  assert.equal(v.text, '- item');
});

test('有序列表 Tab 降级自动重置为 1.，Shift+Tab 升级顺延父级序号并可逆', () => {
  const doc = '1. 第一项\n2. 第二项\n3. 第三项';
  const line2Pos = doc.indexOf('第二项');
  const v = makeMockView(doc, line2Pos);

  assert.equal(indentList(v, 1), true);
  assert.equal(v.text, '1. 第一项\n  1. 第二项\n2. 第三项');

  // Shift+Tab 升回顶层，自动顺延为 2. 且原 2. 第三项恢复为 3. 第三项
  assert.equal(indentList(v, -1), true);
  assert.equal(v.text, '1. 第一项\n2. 第二项\n3. 第三项');

  // 引用内有序列表降级同样自动重置
  const qDoc = '> 1. A\n> 2. B';
  const vq = makeMockView(qDoc, qDoc.length);
  assert.equal(indentList(vq, 1), true);
  assert.equal(vq.text, '> 1. A\n>   1. B');
});

test('嵌套空列表与嵌套空引用按 Enter 逐级退层，顶层再按才退出', () => {
  const vList = makeMockView('    - ', 6);
  assert.equal(continueList(vList), true);
  assert.equal(vList.text, '  - ');
  assert.equal(continueList(vList), true);
  assert.equal(vList.text, '- ');
  assert.equal(continueList(vList), true);
  assert.equal(vList.text, '');

  // 嵌套空有序列表退回父级时顺延父级序号
  const ordDoc = '1. 第一项\n  1. ';
  const vOrd = makeMockView(ordDoc, ordDoc.length);
  assert.equal(continueList(vOrd), true);
  assert.equal(vOrd.text, '1. 第一项\n2. ');

  // 嵌套空引用逐级退一层
  const vQuote = makeMockView('> > ', 4);
  assert.equal(continueQuote(vQuote), true);
  assert.equal(vQuote.text, '> ');
  assert.equal(continueQuote(vQuote), true);
  assert.equal(vQuote.text, '');

  // 引用内嵌套空列表：先退列表缩进 -> 再退列表保留引用 -> 最后退引用
  const vQList = makeMockView('>   - ', 6);
  assert.equal(continueQuote(vQList), true);
  assert.equal(vQList.text, '> - ');
  assert.equal(continueQuote(vQList), true);
  assert.equal(vQList.text, '> ');
  assert.equal(continueQuote(vQList), true);
  assert.equal(vQList.text, '');
});

test('选中列表或引用内文字后按 Enter 先删选区再续标记', () => {
  const listText = '- hello world';
  const v1 = makeMockView(listText, listText.indexOf('world'), listText.length);
  assert.equal(continueList(v1), true);
  assert.equal(v1.text, '- hello \n- ');

  const qText = '> quote tail';
  const v2 = makeMockView(qText, qText.indexOf('tail'), qText.length);
  assert.equal(continueQuote(v2), true);
  assert.equal(v2.text, '> quote \n> ');

  const qlText = '> - item tail';
  const v3 = makeMockView(qlText, qlText.indexOf('tail'), qlText.length);
  assert.equal(continueQuote(v3), true);
  assert.equal(v3.text, '> - item \n> - ');
});

test('Shift+Enter 在列表、引用与正文中执行软换行并对齐缩进', () => {
  const vList = makeMockView('- 第一行', 5);
  assert.equal(softNewline(vList), true);
  assert.equal(vList.text, '- 第一行\n  ');

  const vOrd = makeMockView('  1. 第一行', 8);
  assert.equal(softNewline(vOrd), true);
  assert.equal(vOrd.text, '  1. 第一行\n     ');

  const vQList = makeMockView('> - 第一行', 7);
  assert.equal(softNewline(vQList), true);
  assert.equal(vQList.text, '> - 第一行\n>   ');

  const vQuote = makeMockView('> 引用', 4);
  assert.equal(softNewline(vQuote), true);
  assert.equal(vQuote.text, '> 引用\n> ');

  const vPara = makeMockView('普通正文', 4);
  assert.equal(softNewline(vPara), true);
  assert.equal(vPara.text, '普通正文\n');
});

test('代码块内 {|} / (|) / [|] 回车自动展开缩进并对齐右括号', () => {
  const doc = '```js\nif (ok) {}\n```';
  const pos = doc.indexOf('{}') + 1;
  const v = makeMockView(doc, pos);
  assert.equal(codeBlockEnter(v, 2), true);
  assert.equal(v.text, '```js\nif (ok) {\n  \n}\n```');
  assert.equal(v.pos, doc.indexOf('{') + 4);

  const doc2 = '```js\n  fn()\n```';
  const pos2 = doc2.indexOf('()') + 1;
  const v2 = makeMockView(doc2, pos2);
  assert.equal(codeBlockEnter(v2, 2), true);
  assert.equal(v2.text, '```js\n  fn(\n    \n  )\n```');
});

test('Tab 跳出行内配对闭合符号（**、`、$、)、]）且不误跳开符号', () => {
  const vBold = makeMockView('**粗体**', 4);
  assert.equal(tabOutOfPair(vBold), true);
  assert.equal(vBold.pos, 6);

  const vCode = makeMockView('`code`', 5);
  assert.equal(tabOutOfPair(vCode), true);
  assert.equal(vCode.pos, 6);

  const vMath = makeMockView('$x$', 2);
  assert.equal(tabOutOfPair(vMath), true);
  assert.equal(vMath.pos, 3);

  const vLink = makeMockView('[text](url)', 5);
  assert.equal(tabOutOfPair(vLink), true);
  assert.equal(vLink.pos, 6);

  // 光标在开标记前不应误跳
  const vOpen = makeMockView('hello **world**', 6);
  assert.equal(tabOutOfPair(vOpen), false);
  assert.equal(vOpen.pos, 6);
});

test('代码块内软缩进纯空白行首 Backspace 按缩进宽度整步回删', () => {
  const doc = '```js\n    x\n```';
  const v = makeMockView(doc, doc.indexOf('x'));
  assert.equal(outdentSoftTabOnBackspace(v, 2), true);
  assert.equal(v.text, '```js\n  x\n```');
  assert.equal(outdentSoftTabOnBackspace(v, 2), true);
  assert.equal(v.text, '```js\nx\n```');

  // 非对齐缩进（3 空格）先对齐到 2 空格
  const docOdd = '```js\n   x\n```';
  const vOdd = makeMockView(docOdd, docOdd.indexOf('x'));
  assert.equal(outdentSoftTabOnBackspace(vOdd, 2), true);
  assert.equal(vOdd.text, '```js\n  x\n```');
});

test('任务列表快捷输入容错：- [] 后敲空格自动规范化为 - [ ] ', () => {
  const v1 = makeMockView('- []', 4);
  assert.equal(normalizeEmptyTaskListInput(v1, 4, 4, ' '), true);
  assert.equal(v1.text, '- [ ] ');
  assert.equal(v1.pos, 6);

  const v2 = makeMockView('>   - []', 8);
  assert.equal(normalizeEmptyTaskListInput(v2, 8, 8, ' '), true);
  assert.equal(v2.text, '>   - [ ] ');

  // 代码块内不触发
  const code = '```md\n- []\n```';
  const pos = code.indexOf('[]') + 2;
  const v3 = makeMockView(code, pos);
  assert.equal(normalizeEmptyTaskListInput(v3, pos, pos, ' '), false);
  assert.equal(v3.text, code);
});

/* ---------------- 高频手感、发布效率与性能重构单元测试 ---------------- */

test('字号实时缩放钳制在 12–28px 范围并支持逐级增减', () => {
  assert.equal(clampFontSize(16), 16);
  assert.equal(clampFontSize(8), 12);
  assert.equal(clampFontSize(40), 28);
  assert.equal(stepFontSize(16, 1), 17);
  assert.equal(stepFontSize(16, -1), 15);
  assert.equal(stepFontSize(12, -1), 12);
  assert.equal(stepFontSize(28, 1), 28);
});

test('光标跳转历史支持后退/前进、邻近行去重与跨文件记录', () => {
  const hist = createJumpHistory({ maxEntries: 10, minLineDelta: 5 });
  assert.equal(hist.record({ path: '/a.md', pos: 10, line: 2 }), true);
  // 同文件 5 行以内视为邻近编辑，不重复压栈
  assert.equal(hist.record({ path: '/a.md', pos: 25, line: 4 }), false);
  assert.equal(hist.sizes().back, 1);

  // 大跨度跳转压栈
  assert.equal(hist.record({ path: '/a.md', pos: 500, line: 40 }), true);
  assert.equal(hist.sizes().back, 2);

  // Alt+← 返回上一处
  const b1 = hist.goBack({ path: '/b.md', pos: 0, line: 1 });
  assert.deepEqual(b1, { path: '/a.md', pos: 500, line: 40 });
  const b2 = hist.goBack(b1);
  assert.deepEqual(b2, { path: '/a.md', pos: 25, line: 4 });
  assert.equal(hist.goBack(b2), null);

  // Alt+→ 前进
  const f1 = hist.goForward(b2);
  assert.deepEqual(f1, { path: '/a.md', pos: 500, line: 40 });
  const f2 = hist.goForward(f1);
  assert.deepEqual(f2, { path: '/b.md', pos: 0, line: 1 });
});

test('tabs.js 支持关闭其他、关闭右侧与路径重映射', async () => {
  const synced = [];
  const state = { path: '/docs/b.md' };
  const store = createMockStorage();
  const opened = [];
  const mgr = createTabsManager({
    state,
    view: { state: { doc: { toString: () => '' } } },
    shell: { syncTabs: (list) => synced.push(list) },
    samePath: (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase(),
    settleCurrentDocument: async () => true,
    openDiskDoc: (r) => {
      state.path = r.path;
      opened.push(r.path);
    },
    loadDoc: () => {},
    flash: () => {},
    storage: store,
    getStudio: () => ({
      readFile: async (p) => ({ path: p, content: '# ' + p, encoding: 'utf-8' }),
    }),
  });
  mgr.documentTabs.push(
    { path: '/docs/a.md', editorState: null },
    { path: '/docs/b.md', editorState: null },
    { path: '/docs/c.md', editorState: null },
    { path: '/docs/d.md', editorState: null },
  );

  // 关闭 b.md 右侧（应删掉 c.md 与 d.md）
  await mgr.closeTabsToRight('/docs/b.md');
  assert.deepEqual(mgr.documentTabs.map((t) => t.path), ['/docs/a.md', '/docs/b.md']);

  // 关闭其他，只留 a.md（活动标签原本是 b.md，因此应自动打开 a.md）
  await mgr.closeOtherTabs('/docs/a.md');
  assert.deepEqual(mgr.documentTabs.map((t) => t.path), ['/docs/a.md']);
  assert.deepEqual(opened, ['/docs/a.md']);
});

test('wechat-html.js 按 Orange Heart 与 Lapis 主题生成完整内联样式 HTML', () => {
  const sampleHtml = [
    '<h1>主标题</h1>',
    '<h2>二级标题</h2>',
    '<p>包含 <code>inline</code> 与 <strong>加粗</strong>。</p>',
    '<blockquote><p>引用段落</p></blockquote>',
    '<pre><code class="language-js">const x = 1;</code></pre>',
  ].join('\n');

  const orange = styleWeChatHtml(sampleHtml, { themeId: 'orangeheart' });
  assert.ok(orange.html.includes('data-plume-theme="orangeheart"'));
  assert.ok(orange.html.includes('#ef7060'), '应包含 Orange Heart 强调色 #ef7060');
  assert.ok(orange.html.includes('border-left:4px solid #ef7060'), '引用块应带主题左边框');
  assert.ok(orange.html.includes('background:#fff5f3'), '行内代码与代码块应带主题背景');

  const lapis = styleWeChatHtml(sampleHtml, { themeId: 'lapis' });
  assert.ok(lapis.html.includes('data-plume-theme="lapis"'));
  assert.ok(lapis.html.includes('#4870ac'), '应包含 Lapis 强调色 #4870ac');
  assert.ok(lapis.html.includes('#2c4c7e'), '应包含 Lapis 标题色 #2c4c7e');
  assert.ok(lapis.plain.includes('主标题'));
});

test('quick-open 命令面板支持 > 前缀多词模糊过滤与排序', () => {
  const cmds = [
    { category: '主题', label: '切换主题：Orange Heart 橙心', cmd: 'theme:orangeheart', keywords: 'theme 橙心' },
    { category: '导出', label: '导出为 PDF', cmd: 'export-pdf', keywords: 'pdf print' },
    { category: '发布', label: '复制为公众号 / 富文本样式', cmd: 'copy-wechat', keywords: 'wechat 公众号' },
    { category: '排版', label: '中英文自动加空格', cmd: 'format-spacing', keywords: 'pangu 空格' },
  ];
  assert.equal(filterPaletteCommands(cmds, '>').length, 4);
  const res1 = filterPaletteCommands(cmds, '> 橙心');
  assert.equal(res1.length, 1);
  assert.equal(res1[0].cmd, 'theme:orangeheart');
  const res2 = filterPaletteCommands(cmds, '> wechat 公众号');
  assert.equal(res2.length, 1);
  assert.equal(res2[0].cmd, 'copy-wechat');
  const res3 = filterPaletteCommands(cmds, '> pdf');
  assert.equal(res3[0].cmd, 'export-pdf');
});

test('超大文档视口窗口计算与滚动边界刷新触发正确', () => {
  const w1 = computeBlockWindow(20000, 1, 50, 200);
  assert.deepEqual(w1, { startLine: 1, endLine: 250 });

  const w2 = computeBlockWindow(20000, 5000, 5060, 200);
  assert.deepEqual(w2, { startLine: 4800, endLine: 5260 });

  // 在窗口中部滚动不触发重算
  assert.equal(shouldRefreshBlockWindow(w2, 4950, 5010, 20000, 60), false);
  // 逼近下边界（5210 + 60 > 5260）触发滑动窗口
  assert.equal(shouldRefreshBlockWindow(w2, 5150, 5210, 20000, 60), true);
  // 贴近文档顶部且 startLine===1 不必重复触发
  assert.equal(shouldRefreshBlockWindow(w1, 1, 40, 20000, 60), false);
});

test('shortcuts.js 正确归一化 Ctrl+- 与方向键并包含滚轮缩放参考', () => {
  assert.equal(normAccel('Ctrl+-'), normAccel('Mod--'));
  assert.equal(normAccel('Ctrl+-'), 'ctrl+-');
  assert.equal(normAccel('Alt+←'), normAccel('Alt-ArrowLeft'));
  assert.equal(normAccel('Alt+→'), normAccel('Alt-ArrowRight'));

  const groups = shortcutGroups();
  const allItems = groups.flatMap((g) => g.items);
  assert.ok(allItems.some((i) => i.keys === 'Ctrl+滚轮'), '快捷键参考应包含 Ctrl+滚轮 缩放字体');
  assert.ok(allItems.some((i) => i.cmd === 'zoom-in' && i.keys === 'Ctrl+='));
  assert.ok(allItems.some((i) => i.cmd === 'zoom-out' && i.keys === 'Ctrl+-'));
  assert.ok(allItems.some((i) => i.cmd === 'jump-back' && i.keys === 'Alt+←'));

  const declared = declaredShortcuts();
  const keys = declared.map((d) => normAccel(d.keys));
  assert.equal(new Set(keys).size, keys.length, '声明的快捷键不应有重复键位');
});
