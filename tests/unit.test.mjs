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
  resolveImageFolder,
  panguSpacing,
  countParagraphs,
  matchQuickTrigger,
} from '../src/editor/typora-extras.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

test('panguSpacing 自动补齐中英文空格并跳过代码块、行内代码、链接与公式', () => {
  const input = [
    '使用Plume编辑Markdown文档第1版',
    '跳过`code测试`和[链接Test](https://example.com/中文Test)以及$E=mc^2$公式',
    '```js',
    'const s = "代码里不改ABC中文";',
    '```',
  ].join('\n');
  const out = panguSpacing(input);
  assert.ok(out.includes('使用 Plume 编辑 Markdown 文档第 1 版'));
  assert.ok(out.includes('`code测试`'));
  assert.ok(out.includes('[链接Test](https://example.com/中文Test)'));
  assert.ok(out.includes('const s = "代码里不改ABC中文";'));
});

test('countParagraphs 正确统计段落数', () => {
  assert.equal(countParagraphs('第一段\n续行\n\n第二段\n\n\n第三段'), 3);
  assert.equal(countParagraphs('   '), 0);
});

test('matchQuickTrigger 正确匹配斜杠菜单与 Emoji 补全', () => {
  const slash = matchQuickTrigger('/mer', 10, 4);
  assert.equal(slash.kind, 'slash');
  assert.equal(slash.from, 10);
  assert.equal(slash.items[0].id, 'mermaid');

  const emoji = matchQuickTrigger('你好 :roc', 0, 7);
  assert.equal(emoji.kind, 'emoji');
  assert.equal(emoji.from, 3);
  assert.equal(emoji.items[0].emoji, '🚀');
});
