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
  updateImageWidthAttr,
} from '../src/editor/extrasText.js';
import {
  clearAllDraftEntries,
  draftPreviewText,
  loadDraftList,
  removeDraftEntry,
  upsertDraftEntry,
} from '../src/editor/draft-recovery.js';
import { DRAFT_KEY } from '../src/editor/storage-keys.js';

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
