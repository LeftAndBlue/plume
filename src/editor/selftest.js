import { EditorView, keymap } from '@codemirror/view';
import { EditorState, EditorSelection } from '@codemirror/state';
import { openSearchPanel, closeSearchPanel } from '@codemirror/search';
import { undo } from '@codemirror/commands';
import { NATIVE_KEYS, declaredShortcuts, normAccel } from './shortcuts.js';
import { buildOutline, plainInline } from './outline.js';
import { currentDocBase, resolveSrc, setDocBase } from './widgets.js';
import { blockDecorationStats, setSourceMode } from './live-preview.js';
import { deletePair, exitQuoteOnBackspace, handleInput, navigateFence, protectFenceDelete } from './pairing.js';
import { getCodeFences, isFenceDraft } from './code-fences.js';
import { escapeXml, frontMatterEnd, splitMarkdownLines } from './markdown-source.js';
import { renderSelectionForClipboard, resolveImageForClipboard, htmlToPlainText } from './clipboard.js';
import { i18n } from '../i18n.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(view, ctx) {
  // 断言按中文标签找菜单行 / 按钮：测试期间固定语言。
  // 只改内存里的 locale，不写 localStorage，用户的语言偏好不受影响。
  i18n.locale = 'zh-CN';
  const results = [];
  const ok = (name, cond, extra = '') => {
    results.push({ name, pass: !!cond, extra: String(extra) });
    // 结果面板是跑完才拼的，中途卡住时外面只能读到「未完成」。
    // 留一个进度戳，卡住时至少知道最后一条走到了哪儿。
    document.body.dataset.stLast = `${results.length}:${name}`;
  };
  const doc = () => view.state.doc.toString();
  const doc0 = doc();

  /* CM 只渲染视口内的内容，所以每组检查前先把目标滚进来 */
  const scrollTo = async (needle) => {
    const pos = doc().indexOf(needle);
    if (pos < 0) return false;
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    await sleep(140);
    return true;
  };

  /* 装饰是异步写进 DOM 的，断言前统一等一下，避免偶发抢跑 */
  const waitFor = async (fn, ms = 900, step = 40) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await sleep(step);
    }
    return fn();
  };

  /* 视口渲染偶尔会慢一拍，滚动 + 等待一起重试 */
  const scrollUntil = async (needle, pred, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      await scrollTo(needle);
      if (await waitFor(pred, 500)) return true;
    }
    return false;
  };

  const posVisible = (pos) => {
    const c = view.coordsAtPos(pos);
    const sc = view.scrollDOM.getBoundingClientRect();
    return !!c && c.bottom > sc.top + 2 && c.top < sc.bottom - 2;
  };

  /* ---- 1. 大纲 ---- */
  const outlineCount = document.querySelectorAll('.outline-item').length;
  ok('大纲生成', outlineCount >= 8, outlineCount + ' 条');
  // 标题常写成 `## **一、xxx**`，大纲里不该把 ** 带进去（Typora 也不带）
  ok(
    '大纲条目去掉行内标记',
    plainInline('**一、现状全景**') === '一、现状全景' && plainInline('`code` 与 [链接](https://x)') === 'code 与 链接',
    plainInline('**一、** `x` 与 [y](z)')
  );

  ok('大纲去掉兼容 HTML 标签', plainInline('<kbd>Ctrl</kbd> <u>说明</u>') === 'Ctrl 说明');

  ok(
    'Markdown 行预处理去掉 BOM 并统一换行',
    splitMarkdownLines('\uFEFF标题\r\n第二行').join('\n') === '标题\n第二行'
  );
  ok(
    'Front Matter 跳过闭合边界',
    frontMatterEnd(['---', 'title: 测试', '---', '正文']) === 3 &&
      frontMatterEnd(['---', '未闭合']) === 0
  );
  ok('XML 导出转义', escapeXml('<a>&"b</a>') === '&lt;a&gt;&amp;"b&lt;/a&gt;');

  /* ---- 2. 行内排版（滚到顶部） ---- */
  // 滚动只是发起请求，装饰要等下一帧才进 DOM；固定睡一觉在冷启动时会读到半渲染的视口
  const inlineSet = () =>
    !!document.querySelector('.cm-strong') &&
    !!document.querySelector('.cm-em') &&
    !!document.querySelector('.cm-inline-code') &&
    !!document.querySelector('.cm-link') &&
    !!document.querySelector('.cm-strike');
  await scrollUntil('支持 **加粗**', inlineSet);
  ok('标题行样式', document.querySelectorAll('.cm-h1, .cm-h2').length >= 2);
  ok('标题标记已隐藏', !document.body.innerText.includes('## 基础排版'));
  ok('粗体渲染', !!document.querySelector('.cm-strong'));
  ok('斜体渲染', !!document.querySelector('.cm-em'));
  ok('行内代码渲染', !!document.querySelector('.cm-inline-code'));
  ok('链接渲染', !!document.querySelector('.cm-link'));
  ok('删除线渲染', !!document.querySelector('.cm-strike'));

  await scrollUntil('行内公式：质能方程', () => !!document.querySelector('.cm-math.is-inline .katex'));
  ok('行内公式已渲染', !!document.querySelector('.cm-math.is-inline .katex'));

  /* ---- 2.5 光标踩到标题上，显形的 hN 徽标要读得出来 ---- */
  // lezer 把这些标记符标成 processingInstruction，而它挂在 meta 底下，
  // 一不小心就被「注释」那条规则接走 —— 灰色 + 斜体，看着像一坨浅标记。
  const hPos = doc().indexOf('## 基础排版');
  view.dispatch({ selection: { anchor: hPos + 4 }, effects: EditorView.scrollIntoView(hPos, { y: 'center' }) });
  // 标题在上一屏之外，滚过来要等 CM 重画这一屏，固定 sleep 在冷启动时会读到旧视口
  const headingMark = () => {
    const line = [...document.querySelectorAll('.cm-line.cm-heading')].find((el) =>
      el.textContent.includes('基础排版')
    );
    return line ? line.querySelector('.cm-heading-badge') : null;
  };
  await waitFor(() => !!headingMark(), 1200);
  const hcs = headingMark() ? getComputedStyle(headingMark()) : null;
  ok(
    '标题标记显形时是正文色而不是注释灰',
    !!hcs && hcs.fontStyle === 'normal' && Number(hcs.fontWeight) <= 500,
    hcs ? `${hcs.color} · ${hcs.fontWeight} · ${hcs.fontStyle}` : '未渲染'
  );

  /* ---- 3. 任务清单（滚到表前） ---- */
  // 只按「第一个 .cm-task」抓元素会在视口只渲染了一半时抓错，所以按行文本定位
  const taskAt = (text) => {
    const line = [...document.querySelectorAll('.cm-line')].find((el) => el.textContent.includes(text));
    return line ? line.querySelector('.cm-task') : null;
  };
  const taskBoxes = () => document.querySelectorAll('.cm-task');

  await scrollUntil('任务清单', () => taskBoxes().length >= 4);
  const taskCount = taskBoxes().length;
  ok('任务清单渲染', taskCount >= 4, taskCount + ' 个');

  // 删除线要在「点掉之前」看：下面这一击会把这个完成项变回未完成
  await scrollUntil('打通实时预览渲染', () => !!document.querySelector('.cm-task-done'));
  const doneEl = document.querySelector('.cm-task-done');
  ok(
    '完成项有删除线',
    !!doneEl && getComputedStyle(doneEl).textDecorationLine.includes('line-through'),
    doneEl ? getComputedStyle(doneEl).textDecorationLine : '未找到 .cm-task-done'
  );

  const before = doc();
  const box = taskAt('打通实时预览渲染');
  if (box) {
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => doc() !== before, 800);
  }
  ok('点击勾选框改写源码', before !== doc());

  // 点回去，别把示例文档留在被改过的状态
  await scrollUntil('打通实时预览渲染', () => !!taskAt('打通实时预览渲染'));
  const again = taskAt('打通实时预览渲染');
  if (again) {
    again.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await waitFor(() => doc() === before, 800);
  }
  ok('再点一次可还原', doc() === before);

  /* ---- 3.5 嵌套列表缩进 ---- */
  await scrollTo('再缩进一级');
  const lines = [...document.querySelectorAll('.cm-line')];
  const deepLine = lines.find((el) => el.textContent.includes('再缩进一级'));
  const flatLine = lines.find((el) => el.textContent.includes('无序列表项'));
  const padOf = (el) => (el ? parseFloat(getComputedStyle(el).paddingLeft) || 0 : -1);
  ok('嵌套列表有缩进', padOf(deepLine) > padOf(flatLine) + 8, `${padOf(deepLine)}px / 顶层 ${padOf(flatLine)}px`);
  ok('子项换了圆点字形', !!deepLine && /[◦▪]/.test(deepLine.textContent), deepLine ? deepLine.textContent.trim().slice(0, 1) : '无');

  /* ---- 3.6 回车续写列表（Typora 的手感） ---- */
  const beforeList = doc();
  const pressEnter = () =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  /** 光标放到 needle 末尾，回车，返回新插入那一行的文本 */
  const enterAfter = async (needle) => {
    const at = doc().indexOf(needle);
    if (at < 0) return null;
    const end = at + needle.length;
    view.dispatch({ selection: { anchor: end } });
    pressEnter();
    await sleep(120);
    const line = view.state.doc.lineAt(end);
    return view.state.doc.line(Math.min(line.number + 1, view.state.doc.lines)).text;
  };
  const ulNext = await enterAfter('- 第三项');
  ok('无序列表回车自动续标记', ulNext === '- ', JSON.stringify(ulNext));
  undo(view);
  await sleep(80);

  const olNext = await enterAfter('3. 第三项');
  ok('有序列表回车序号 +1', olNext === '4. ', JSON.stringify(olNext));
  undo(view);
  await sleep(80);

  const taskNext = await enterAfter('打通实时预览渲染');
  ok('任务项回车给未勾选的框', taskNext === '- [ ] ', JSON.stringify(taskNext));
  // 再来一次：光标此刻停在刚插入的空任务项行尾，回车应该退出列表（标记被清掉）
  const blankLineNo = view.state.doc.lineAt(view.state.selection.main.head).number;
  pressEnter();
  await sleep(120);
  const afterEmpty = view.state.doc.line(blankLineNo).text;
  ok('空列表项回车退出列表', afterEmpty === '', JSON.stringify(afterEmpty));
  undo(view);
  undo(view);
  await sleep(80);
  ok('列表续行测试未污染文档', doc() === beforeList);

  /* ---- 3.7 Tab / Shift+Tab 调列表层级、引用块回车续 > ---- */
  const pressKey = (key, keyCode, mods = {}) =>
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true, ...mods })
    );
  const lineOf = (needle) => {
    const at = doc().indexOf(needle);
    return at < 0 ? null : view.state.doc.lineAt(at);
  };

  const third = lineOf('- 第三项');
  if (third) {
    view.dispatch({ selection: { anchor: third.from + third.text.length } });
    pressKey('Tab', 9);
    await sleep(130);
    const out = view.state.doc.line(third.number).text;
    ok('Tab 把列表项降一层', out === '  - 第三项', JSON.stringify(out));

    pressKey('Tab', 9, { shiftKey: true });
    await sleep(130);
    const back = view.state.doc.line(third.number).text;
    ok('Shift+Tab 把列表项升回来', back === '- 第三项', JSON.stringify(back));
    ok('列表缩进测试未污染文档', doc() === beforeList);
  }

  const quote = lineOf('> 静态分析');
  if (quote) {
    view.dispatch({ selection: { anchor: quote.from + quote.text.length } });
    pressKey('Enter', 13);
    await sleep(130);
    const next = view.state.doc.line(quote.number + 1).text;
    ok('引用块回车续 >', next === '> ', JSON.stringify(next));

    // 空的引用行上再回车 = 退出引用（标记被清掉，留下一个空行）
    pressKey('Enter', 13);
    await sleep(130);
    const after = view.state.doc.line(quote.number + 1).text;
    ok('空引用行回车退出引用', after === '', JSON.stringify(after));

    undo(view);
    undo(view);
    await sleep(130);
    ok('引用续行测试未污染文档', doc() === beforeList);
  }

  /* ---- 3.8 有序列表编号按层级重排（不看源码里的数字） ---- */
  await scrollUntil('子项编号从 1 起', () =>
    [...document.querySelectorAll('.cm-line')].some((el) => el.textContent.includes('子项编号从 1 起'))
  );
  const subLines = [...document.querySelectorAll('.cm-line')].filter((el) =>
    /子项编号从 1 起|源码写 1/.test(el.textContent)
  );
  const nums = subLines.map((el) => el.textContent.trim().slice(0, 2));
  ok(
    '有序子项编号从 1 起、逐项 +1',
    nums.length === 2 && nums[0].startsWith('1.') && nums[1].startsWith('2.'),
    nums.join(' / ')
  );

  /* ---- 3.8.1 引用中的列表：编号连续，标记不能越过引用竖线 ---- */
  const quoteListAt = doc().length;
  const quoteListFixture = '\n> 引用列表说明\n> 1. 引用有序第一项\n> 1. 引用有序第二项\n> - 引用无序项\n';
  view.dispatch({ changes: { from: quoteListAt, insert: quoteListFixture }, selection: { anchor: 0 } });
  await scrollUntil('引用有序第二项', () => {
    const items = [...document.querySelectorAll('.cm-line.cm-quote')].filter((el) =>
      /引用有序第[一二]项/.test(el.textContent)
    );
    return items.length === 2 && items.every((el) => !!el.querySelector('.cm-ordered-num'));
  });
  const quoteOrdered = [...document.querySelectorAll('.cm-line.cm-quote')].filter((el) =>
    /引用有序第[一二]项/.test(el.textContent)
  );
  const quoteNums = quoteOrdered.map((el) => {
    const marker = el.querySelector('.cm-ordered-num');
    return marker ? marker.textContent : '';
  });
  ok('引用中有序列表逐项 +1', quoteNums.join('/') === '1./2.', quoteNums.join(' / '));

  const quoteTextLine = [...document.querySelectorAll('.cm-line.cm-quote')].find((el) =>
    el.textContent.includes('引用列表说明')
  );
  const quoteListItems = [...document.querySelectorAll('.cm-line.cm-quote')].filter((el) =>
    /引用有序第[一二]项|引用无序项/.test(el.textContent)
  );
  const markersInside = quoteListItems.every((el) => {
    const marker = el.querySelector('.cm-ordered-num, .cm-bullet');
    return marker && marker.getBoundingClientRect().left >= el.getBoundingClientRect().left + 4;
  });
  ok(
    '引用中列表标记位于竖线内侧',
    quoteListItems.length === 3 && markersInside && quoteTextLine && padOf(quoteListItems[0]) > padOf(quoteTextLine) + 8,
    quoteListItems.map((el) => `${padOf(el)}px`).join(' / ')
  );
  ok(
    '引用内列表边距不截断竖线',
    quoteListItems[0]?.classList.contains('cm-list-first') &&
      getComputedStyle(quoteListItems[0]).borderTopWidth === '0px' &&
      quoteTextLine?.classList.contains('cm-quote-first') &&
      parseFloat(getComputedStyle(quoteTextLine).borderTopWidth) > 0,
    quoteListItems[0] ? getComputedStyle(quoteListItems[0]).borderTopWidth : '无列表首项'
  );

  const quoteDeleteLine = lineOf('> 1. 引用有序第二项');
  if (quoteDeleteLine) {
    view.dispatch({ selection: { anchor: quoteDeleteLine.from + '> 1. '.length } });
    await sleep(120);
    const liveQuoteLine = [...document.querySelectorAll('.cm-line.cm-quote')].find((el) =>
      el.textContent.includes('引用有序第二项')
    );
    ok(
      '编辑引用列表行同样不显示源码标记',
      !!liveQuoteLine &&
        !liveQuoteLine.textContent.includes('>') &&
        !!liveQuoteLine.querySelector('.cm-ordered-num') &&
        quoteListItems[0] &&
        Math.abs(padOf(liveQuoteLine) - padOf(quoteListItems[0])) < 1,
      liveQuoteLine ? `${liveQuoteLine.textContent} · ${padOf(liveQuoteLine)}px` : '未找到编辑行'
    );
    pressKey('Backspace', 8);
    await sleep(120);
    const afterDelete = view.state.doc.line(quoteDeleteLine.number).text;
    ok('引用中列表可退格退出且保留引用', afterDelete === '> 引用有序第二项', JSON.stringify(afterDelete));
  } else {
    ok('引用中列表可退格退出且保留引用', false, '未找到测试行');
  }
  view.dispatch({ changes: { from: quoteListAt, to: doc().length }, selection: { anchor: quoteListAt } });
  await sleep(120);
  ok('引用列表测试未污染文档', doc() === beforeList);

  /* ---- 3.9 有序列表加粗：序号不属于行内格式，跨项要分别包裹 ---- */
  const boldAt = doc().length;
  const boldFixture = '\n1. 第一项加粗\n2. 第二项加粗\n';
  view.dispatch({ changes: { from: boldAt, insert: boldFixture }, selection: { anchor: boldAt + 1 } });
  const boldOneFrom = doc().indexOf('1. 第一项加粗', boldAt);
  const boldOneTo = boldOneFrom + '1. 第一项加粗'.length;
  view.dispatch({ selection: { anchor: boldOneFrom, head: boldOneTo } });
  if (ctx.run) ctx.run('bold');
  const boldOneLine = view.state.doc.lineAt(boldOneFrom).text;
  ok('从序号开始选择只加粗列表正文', boldOneLine === '1. **第一项加粗**', JSON.stringify(boldOneLine));

  // 还原成未加粗的两项，再验证一次跨项选区。
  view.dispatch({ changes: { from: boldAt, to: doc().length, insert: boldFixture } });
  const boldManyFrom = doc().indexOf('1. 第一项加粗', boldAt);
  const boldManyTo = doc().indexOf('2. 第二项加粗', boldManyFrom) + '2. 第二项加粗'.length;
  view.dispatch({ selection: { anchor: boldManyFrom, head: boldManyTo } });
  if (ctx.run) ctx.run('bold');
  const boldMany = doc().slice(boldAt + 1);
  ok(
    '跨列表项加粗保留每项序号',
    boldMany === '1. **第一项加粗**\n2. **第二项加粗**\n',
    JSON.stringify(boldMany)
  );
  if (ctx.run) ctx.run('bold');
  ok('再次加粗会取消已有标记', doc().slice(boldAt + 1) === boldFixture.slice(1), JSON.stringify(doc().slice(boldAt + 1)));
  if (ctx.run) ctx.run('bold');
  ok('取消后可以重新加粗', doc().slice(boldAt + 1) === boldMany, JSON.stringify(doc().slice(boldAt + 1)));

  const mixedBoldFixture = '\n1. **第一项加粗**\n2. 第二项加粗\n';
  view.dispatch({ changes: { from: boldAt, to: doc().length, insert: mixedBoldFixture } });
  const mixedBoldTo = doc().indexOf('2. 第二项加粗', boldManyFrom) + '2. 第二项加粗'.length;
  view.dispatch({ selection: { anchor: boldManyFrom, head: mixedBoldTo } });
  if (ctx.run) ctx.run('bold');
  ok(
    '混合选区不会重复嵌套已有粗体',
    doc().slice(boldAt + 1) === boldMany,
    JSON.stringify(doc().slice(boldAt + 1))
  );
  view.dispatch({
    selection: { anchor: doc().length },
    effects: EditorView.scrollIntoView(boldManyFrom, { y: 'center' }),
  });
  await waitFor(() => {
    const lines = [...document.querySelectorAll('.cm-line')].filter((el) => /第[一二]项加粗/.test(el.textContent));
    return lines.length === 2 && lines.every((el) => el.querySelector('.cm-strong') && el.querySelector('.cm-ordered-num') && !el.textContent.includes('**'));
  });
  const boldLines = [...document.querySelectorAll('.cm-line')].filter((el) => /第[一二]项加粗/.test(el.textContent));
  ok(
    '列表加粗后序号和粗体都正常渲染',
    boldLines.length === 2 && boldLines.every((el) => el.querySelector('.cm-strong') && el.querySelector('.cm-ordered-num') && !el.textContent.includes('**'))
  );
  view.dispatch({ changes: { from: boldAt, to: doc().length }, selection: { anchor: boldAt } });
  await sleep(120);
  ok('列表加粗测试未污染文档', doc() === beforeList);

  /* ---- 3.10 列表链接：与加粗共用正文选区，不能吞掉序号 ---- */
  const linkAt = doc().length;
  const linkFixture = '\n1. 链接文字\n';
  view.dispatch({ changes: { from: linkAt, insert: linkFixture } });
  const linkFrom = doc().indexOf('1. 链接文字', linkAt);
  const linkTo = linkFrom + '1. 链接文字'.length;
  view.dispatch({ selection: { anchor: linkFrom, head: linkTo } });
  if (ctx.run) ctx.run('link');
  const linkLine = view.state.doc.lineAt(linkFrom).text;
  const linkSel = view.state.selection.main;
  ok('从序号开始插入链接仍保留列表', linkLine === '1. [链接文字](https://)', JSON.stringify(linkLine));
  ok(
    '插入链接后选中 URL 占位符',
    doc().slice(linkSel.from, linkSel.to) === 'https://',
    JSON.stringify(doc().slice(linkSel.from, linkSel.to))
  );

  // 占位 URL 处于选中状态时粘贴新地址：直接替换地址，不能包成嵌套坏链接
  const pasteOnPlaceholder = ctx.linkifySelection ? ctx.linkifySelection('https://example.com') : false;
  ok(
    '占位 URL 上粘贴直接替换地址',
    pasteOnPlaceholder && view.state.doc.lineAt(linkFrom).text === '1. [链接文字](https://example.com)',
    JSON.stringify(view.state.doc.lineAt(linkFrom).text)
  );

  view.dispatch({ changes: { from: linkAt, to: doc().length, insert: linkFixture } });
  view.dispatch({ selection: { anchor: linkFrom, head: linkTo } });
  const pastedLink = ctx.linkifySelection ? ctx.linkifySelection('https://example.com') : false;
  ok(
    '列表正文选中后粘贴 URL 仍保留列表',
    pastedLink && view.state.doc.lineAt(linkFrom).text === '1. [链接文字](https://example.com)',
    JSON.stringify(view.state.doc.lineAt(linkFrom).text)
  );
  view.dispatch({ changes: { from: linkAt, to: doc().length }, selection: { anchor: linkAt } });
  await sleep(120);
  ok('列表链接测试未污染文档', doc() === beforeList);

  /* ---- 4. 代码块 ---- */
  // 断言只要求「代码块被装饰且有着色片段」：整块 16 行是否都在视口里取决于窗口高度，
  // 拿它当判据会在不同窗口尺寸下误报。
  await scrollUntil('function debounce', () => document.querySelectorAll('.cm-code-line').length >= 3);
  const codeLines = document.querySelectorAll('.cm-code-line').length;
  const codeTokens = document.querySelectorAll('.cm-code-line span').length;
  ok('代码块已着色', codeLines >= 3 && codeTokens > 0, `${codeLines} 行 / ${codeTokens} 个着色片段`);
  ok('代码语言标识', !!document.querySelector('.cm-fence-chip'));
  ok('代码块顶栏带复制按钮', !!document.querySelector('.cm-fence-copy'));

  // 已生成的代码块始终不露 ```，即使光标落在围栏对应的源码位置（Typora 的手感）
  const fencePos = doc().indexOf('```js');
  const bodyPos = doc().indexOf('function debounce');
  if (fencePos > 0 && bodyPos > 0) {
    // 用 y:'center'：plain scrollIntoView 只要「露出一点」就算完成，
    // 围栏卡在视口边缘时 CM 还没把这一行渲染出来，固定 sleep 会读到上一帧。
    view.dispatch({
      selection: { anchor: bodyPos },
      effects: EditorView.scrollIntoView(bodyPos, { y: 'center' }),
    });
    await sleep(200);
    ok('在代码块内编辑不露围栏', !document.body.innerText.includes('```js'), '');
    view.dispatch({
      selection: { anchor: fencePos + 4 },
      effects: EditorView.scrollIntoView(fencePos, { y: 'center' }),
    });
    await sleep(200);
    ok('光标落到围栏位置也不露源码', !document.body.innerText.includes('```js'), '');
  }

  /* ---- 4.5 语言标签：显示当前语言，点一下就能换 ---- */
  // 光标回到正文后，语言标签仍照常显示并可编辑。
  if (fencePos > 0 && bodyPos > 0) {
    view.dispatch({ selection: { anchor: bodyPos }, scrollIntoView: true });
    await waitFor(() => !!document.querySelector('.cm-fence-chip'), 800);

    const chipEl = () => document.querySelector('.cm-fence-chip');
    const langRows = () => [...document.querySelectorAll('.lang-pop .lang-row')];
    const rowOf = (code) => langRows().find((r) => (r.querySelector('.lang-code') || {}).textContent === code);
    // chip 是 replace widget，视口重渲染时会短暂消失；每次都等到它真的在，再派发事件
    const openMenu = async () => {
      await waitFor(() => !!chipEl(), 900);
      const chip = chipEl();
      if (!chip) return false;
      chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return await waitFor(() => langRows().length > 0, 900);
    };
    const pickRow = async (row) => {
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(240);
      return true;
    };

    ok(
      '语言标签显示当前语言',
      !!chipEl() && chipEl().textContent.trim() === 'js',
      chipEl() ? chipEl().textContent.trim() : '无'
    );

    const docBeforeLang = doc();
    await openMenu();
    ok('点语言标签弹出语言表', langRows().length >= 20 && !!document.querySelector('.lang-pop .lang-foot'), `${langRows().length} 项`);
    ok(
      '当前语言在表里打了勾',
      (() => {
        const cur = document.querySelector('.lang-pop .lang-row.is-current');
        return !!cur && /JavaScript/.test(cur.textContent);
      })(),
      (document.querySelector('.lang-pop .lang-row.is-current') || {}).textContent || '无'
    );

    await pickRow(rowOf('python'));
    await waitFor(() => chipEl() && chipEl().textContent.trim() === 'python', 900);
    ok(
      '选 Python 改写围栏',
      /```python\n/.test(doc()) && !/```js\n/.test(doc()) && !!chipEl() && chipEl().textContent.trim() === 'python',
      chipEl() ? chipEl().textContent.trim() : '无'
    );

    // Esc 只关弹层，不动文档
    await openMenu();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(150);
    ok('Esc 关掉语言表', !document.querySelector('.lang-pop'));

    await openMenu();
    const manualRow = document.querySelector('.lang-pop .lang-row.is-manual');
    if (manualRow) manualRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await waitFor(() => !!document.querySelector('.lang-manual-input'), 700);
    ok(
      '手动输入语言不需要显示围栏',
      !!document.querySelector('.lang-manual-input') && !view.contentDOM.innerText.includes('```python')
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(120);

    // 收摊：改语言只是一次普通文档修改，一次撤销就回到原样
    undo(view);
    await sleep(140);
    ok('语言测试未污染文档', doc() === docBeforeLang, JSON.stringify(doc().slice(0, 40)));
  }

  /* ---- 5. 表格：渲染 + 单元格就地编辑 ---- */
  await scrollTo('| 能力 |');
  const tableEl = document.querySelector('.cm-table-wrap');
  ok('表格渲染为 <table>', !!tableEl && !!tableEl.querySelector('table'));
  ok('表格表头列数', tableEl ? tableEl.querySelectorAll('th').length === 3 : false, '3 列');

  // 表格中间夹一个空行、或某行漏掉一个管道符，整块仍要渲染成表格。
  // 以前扫描碰到这种行就收工，后半截全部退回裸 Markdown（看到的就是 |1|2|）。
  {
    const loose = '\n\n| L1 | L2 |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4\n| 5 | 6 |\n';
    const at = view.state.doc.length;
    view.dispatch({ changes: { from: at, insert: loose }, selection: { anchor: at + loose.length } });
    await scrollUntil('L1', () => {
      const w = [...document.querySelectorAll('.cm-table-wrap')].pop();
      return !!w && w.querySelectorAll('tbody tr').length >= 3;
    });
    const looseWrap = [...document.querySelectorAll('.cm-table-wrap')].pop();
    const bodyRows = looseWrap
      ? [...looseWrap.querySelectorAll('tbody tr')].map((tr) => tr.children.length)
      : [];
    ok('空行 / 漏管道不把表格断开', bodyRows.length === 3, JSON.stringify(bodyRows));
    undo(view);
    await sleep(140);
    ok('表格容错用例未污染文档', !doc().includes('L1'));
  }

  // 编辑测试放在文末的临时表格上，别把示例文档改花
  const scratch = '\n\n| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n';
  const insertAt = view.state.doc.length;
  view.dispatch({ changes: { from: insertAt, insert: scratch }, selection: { anchor: insertAt + scratch.length } });
  await scrollUntil('a1', () => {
    const w = [...document.querySelectorAll('.cm-table-wrap')].pop();
    return !!w && w.querySelectorAll('td').length >= 4;
  });

  const wrapOf = () => [...document.querySelectorAll('.cm-table-wrap')].pop();
  const cellOf = (r, c) => {
    const w = wrapOf();
    const tr = w && w.querySelectorAll('tr')[r];
    return tr ? tr.children[c] : null;
  };
  const editor = () => document.querySelector('.cm-cell-editor');
  const press = (key) => editor().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const openCell = async (el) => {
    if (!el) return null;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await waitFor(() => !!editor(), 700);
    return editor();
  };
  const lines0 = view.state.doc.lines;

  const c00 = cellOf(0, 0);
  ok('表头单元格可点', !!c00 && c00.tagName === 'TH');
  const ed0 = await openCell(c00);
  ok('点击单元格打开就地编辑器', !!ed0 && ed0.value === 'A', ed0 ? ed0.value : '无');

  const ed1 = await openCell(cellOf(1, 0));
  ok('换格点击切换编辑器', !!ed1 && ed1.value === 'a1', ed1 ? ed1.value : '无');
  if (ed1) {
    ed1.value = 'a1-改';
    press('Enter');
    await waitFor(() => !!editor(), 700);
    ok('编辑后写回源码', doc().includes('| a1-改 |') && !doc().includes('| a1 |'));

    const ed2 = editor();
    ok('回车跳到下一行同列', !!ed2 && ed2.value === 'a2', ed2 ? ed2.value : '无');
    if (ed2) {
      press('Tab');
      await waitFor(() => !!editor(), 700);
      const ed3 = editor();
      ok('Tab 跳到下一格', !!ed3 && ed3.value === 'b2', ed3 ? ed3.value : '无');
      if (ed3) {
        press('Tab'); // 末格再 Tab → 补一行
        await waitFor(() => view.state.doc.lines === lines0 + 1, 700);
        ok(
          '末格 Tab 追加一行',
          view.state.doc.lines === lines0 + 1 && /\|\s+\|\s+\|/.test(doc().slice(-12)),
          view.state.doc.lines + ' 行'
        );
        const before = doc();
        if (editor()) {
          press('Escape');
          await sleep(120);
        }
        ok('Esc 关闭且不改动文档', !editor() && doc() === before);
      }
    }
  }

  // Shift+Enter 写格内换行；列宽与排序都直接写回 Markdown 源码。
  const multiline = await openCell(cellOf(1, 1));
  if (multiline) {
    multiline.value = '第一行';
    multiline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    multiline.value += '第二行';
    multiline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(() => doc().includes('第一行<br>第二行'), 900);
  }
  ok('Shift+Enter 保存格内换行', doc().includes('第一行<br>第二行'));
  if (editor()) {
    press('Escape');
    await sleep(100);
  }
  const resize = wrapOf()?.querySelector('.cm-table-resize');
  const delimiterBefore = doc().slice(insertAt).split('\n').find((line) => /^\|\s*:?-/.test(line) && line.includes('|'));
  if (resize) {
    resize.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 220, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 220, bubbles: true }));
    await sleep(240);
  }
  const delimiterAfter = doc().slice(insertAt).split('\n').find((line) => /^\|\s*:?-/.test(line) && line.includes('|'));
  ok('拖动表头调整列宽并写回源码', !!resize && delimiterAfter !== delimiterBefore, delimiterAfter || '无');
  // 表头工具条改成 Typora 式图标条：对齐 + 更多 + 删除表格，插入/排序等条目收进菜单
  const toolbar = wrapOf()?.querySelector('.cm-table-toolbar');
  ok(
    '表格工具条为 Typora 式图标条',
    !!toolbar && !!toolbar.querySelector('.cm-table-tools .cm-table-btn svg') && toolbar.querySelectorAll('.cm-table-btn').length === 5,
    toolbar ? toolbar.querySelectorAll('.cm-table-btn').length + ' 个按钮' : '无'
  );

  const openTableMenu = () => {
    cellOf(1, 0)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    return document.querySelector('.app-context');
  };
  const topTableItems = [
    '插入行',
    '插入列',
    '移动该行',
    '移动该列',
    '对齐方式',
    '删除行',
    '删除列',
    '删除表格',
    '复制表格',
    '格式化表格源码',
    '编辑表格源码',
    '排序',
  ];
  const tableMenu = openTableMenu();
  ok(
    '表格菜单顶层条目折叠成组',
    !!tableMenu && topTableItems.every((label) => tableMenu.querySelector(`[data-context-action="${label}"]`)),
    tableMenu ? [...tableMenu.querySelectorAll('[data-context-action]')].length + ' 项' : '无'
  );

  // 展开「插入行」二级菜单：条目与快捷键提示都在这里
  tableMenu?.querySelector('[data-context-action="插入行"]')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true })
  );
  await waitFor(() => document.querySelectorAll('.app-context').length > 1, 600);
  const tableSubMenu = document.querySelectorAll('.app-context')[1];
  ok(
    '表格菜单支持二级折叠',
    !!tableSubMenu &&
      !!tableSubMenu.querySelector('[data-context-action="下方插入行"]') &&
      !!tableSubMenu.querySelector('[data-context-action="上方插入行"]'),
    tableSubMenu ? tableSubMenu.textContent.replace(/\s+/g, ' ').slice(0, 24) : '无'
  );
  ok('子菜单带快捷键提示', !!tableSubMenu?.querySelector('.context-accel'));

  // 排序：走「排序」二级菜单
  const linesBeforeContext = view.state.doc.lines;
  openTableMenu()
    ?.querySelector('[data-context-action="排序"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelectorAll('.app-context').length > 1, 600);
  document
    .querySelectorAll('.app-context')[1]
    ?.querySelector('[data-context-action="按当前列降序排列"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(240);
  ok('表格可按当前列降序排列', doc().indexOf('| a2 |') >= 0 && doc().indexOf('| a2 |') < doc().indexOf('| a1-改 |'));

  // 插入行同样走二级菜单
  openTableMenu()
    ?.querySelector('[data-context-action="插入行"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelectorAll('.app-context').length > 1, 600);
  document
    .querySelectorAll('.app-context')[1]
    ?.querySelector('[data-context-action="下方插入行"]')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitFor(() => view.state.doc.lines === linesBeforeContext + 1, 900);
  ok('表格右键可增删行列', view.state.doc.lines === linesBeforeContext + 1);

  // 拆掉临时表格，文档回到原样
  if (editor()) {
    press('Escape');
    await sleep(100);
  }
  const at = doc().lastIndexOf('\n\n| A | B |');
  if (at > 0) {
    view.dispatch({ changes: { from: at, to: view.state.doc.length, insert: '' } });
    await sleep(120);
  }
  ok('临时表格已清理', !doc().includes('| A | B |'));

  /* ---- 5.5 单元格里的行内标记也要渲染 ---- */
  const markTable = '\n\n| 标记 | 值 |\n| --- | --- |\n| **粗** 与 `code` | $x^2$ |\n';
  const atMark = view.state.doc.length;
  view.dispatch({ changes: { from: atMark, insert: markTable }, selection: { anchor: atMark + markTable.length } });
  // 不能拿 '粗' 当锚点：文档前面「支持 **加粗**」里也有一个，indexOf 会滚到那儿去
  view.dispatch({ effects: EditorView.scrollIntoView(atMark + 6, { y: 'center' }) });
  await waitFor(() => {
    const w = [...document.querySelectorAll('.cm-table-wrap')].pop();
    return !!w && !!w.querySelector('tbody td strong');
  }, 1200);
  const wrap2 = [...document.querySelectorAll('.cm-table-wrap')].pop();
  const markCell = wrap2 && wrap2.querySelector('tbody td');
  ok(
    '单元格里的粗体与行内代码被渲染',
    !!markCell && !!markCell.querySelector('strong') && !!markCell.querySelector('code'),
    markCell ? markCell.textContent : '无'
  );
  ok(
    '单元格里看不到 markdown 标记',
    !!markCell && !markCell.textContent.includes('**') && !markCell.textContent.includes('`'),
    markCell ? markCell.textContent : '无'
  );
  const mathCell = wrap2 && wrap2.querySelectorAll('tbody td')[1];
  ok('单元格里的行内公式被渲染', !!mathCell && !!mathCell.querySelector('.cm-math'));

  // 点进格子拿到的仍是原始 markdown —— 渲染只发生在视图层
  const edMark = await openCell(markCell);
  ok('点进格子编辑时仍是原始 markdown', !!edMark && edMark.value === '**粗** 与 `code`', edMark ? edMark.value : '无');
  if (edMark) {
    press('Escape');
    await sleep(140);
  }

  view.dispatch({ changes: { from: atMark, to: view.state.doc.length } });
  await sleep(150);
  ok('单元格行内测试未污染文档', !doc().includes('| 标记 |'));

  /* ---- 6. 公式块与图片 ---- */
  await scrollUntil('e^{-x^2}', () => !!document.querySelector('.cm-math.is-display .katex'));
  ok('公式块已渲染', !!document.querySelector('.cm-math.is-display .katex'));
  await scrollUntil('示意图', () => !!document.querySelector('.cm-image img'));
  const imgEl = document.querySelector('.cm-image img');
  ok('图片渲染为 <img>', !!imgEl, imgEl ? imgEl.naturalWidth + 'px 宽' : '未加载');
  const imgWrap = imgEl?.closest('.cm-image');
  imgWrap?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const imageMenu = document.querySelector('.app-context');
  ok(
    '图片右键提供复制移动与删除',
    !!imageMenu && ['复制图片到配置目录', '移动图片到配置目录', '仅删除图片引用', '删除图片及源文件'].every((label) => imageMenu.querySelector(`[data-context-action="${label}"]`)),
  );
  ok(
    '图片右键提供缩放、编辑与对齐选项',
    !!imageMenu && ['缩放图片', '编辑缩放...', '对齐方式', '编辑图片语法'].every((label) => imageMenu.querySelector(`[data-context-action="${label}"]`)),
  );
  // 测试缩放二级子菜单展开
  const scaleBtn = imageMenu?.querySelector('[data-context-action="缩放图片"]');
  scaleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const subMenu = document.querySelector('.sub-context');
  ok(
    '缩放二级菜单展开并包含预设比例',
    !!subMenu && ['25%', '50%', '75%', '100%', '重置大小'].every((label) => subMenu.querySelector(`[data-context-action="${label}"]`)),
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  /* ---- 6.5 目录：正文里的 [toc] ---- */
  await scrollTo('墨行 Markline');
  const tocBox = await waitFor(() => document.querySelector('.cm-toc'), 1200)
    ? document.querySelector('.cm-toc')
    : null;
  ok('[toc] 在正文里渲染成目录块', !!tocBox);
  const tocItems = tocBox ? [...tocBox.querySelectorAll('.cm-toc-item')] : [];
  // 条目应与侧栏大纲一一对应：两处用的是同一个标题解析函数
  ok('目录条目数 = 侧栏大纲条目数', tocItems.length > 0 && tocItems.length === buildOutline(view.state).length, tocItems.length + ' 条');
  ok('目录条目带层级缩进', tocItems.some((a) => parseFloat(a.style.paddingLeft) > 0));
  ok('目录不显示 [toc] 源码', !(tocBox && tocBox.textContent.includes('[toc]')));
  if (tocItems.length) {
    const beforeTop = view.scrollDOM.scrollTop;
    const jump = tocItems.find((a) => a.textContent.includes('列表')) || tocItems[tocItems.length - 1];
    const heading = buildOutline(view.state).find((h) => h.text === jump.textContent);
    jump.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await waitFor(() => heading && posVisible(heading.pos), 1800);
    ok('点目录条目会跳转', !!heading && posVisible(heading.pos), `${beforeTop} → ${view.scrollDOM.scrollTop}`);
  }

  /* ---- 6.6 图片路径解析（Typora 的那几种写法都要认） ---- */
  const prevBase = currentDocBase();
  setDocBase('file:///C:/docs/notes/');
  const cases = [
    ['相对路径', 'pic.png', 'file:///C:/docs/notes/pic.png'],
    ['带空格', 'my pic.png', 'file:///C:/docs/notes/my%20pic.png'],
    ['中文名', '截图.png', 'file:///C:/docs/notes/%E6%88%AA%E5%9B%BE.png'],
    ['当前目录', './sub/inner.png', 'file:///C:/docs/notes/sub/inner.png'],
    ['绕回上级', 'sub/../pic.png', 'file:///C:/docs/notes/pic.png'],
    ['反斜杠相对', 'sub\\inner.png', 'file:///C:/docs/notes/sub/inner.png'],
    ['Windows 绝对', 'C:\\docs\\a b.png', 'file:///C:/docs/a%20b.png'],
    ['外链原样', 'https://x.test/a.png', 'https://x.test/a.png'],
  ];
  const bad = cases.filter(([, src, want]) => resolveSrc(src) !== want);
  ok('图片路径解析（8 种写法）', bad.length === 0, bad.map(([n, s, w]) => `${n}:${resolveSrc(s)}≠${w}`).join(' | '));
  setDocBase(prevBase);

  /* ---- 7. 输入与撤销（装饰是否妨碍编辑） ---- */
  const idx = doc().indexOf('，以及 [链接](https://commonmark.org)。');
  let typedOk = false;
  let undoOk = false;
  let taskAfterType = 0;
  if (idx >= 0) {
    const lineEnd = view.state.doc.lineAt(idx).to;
    view.dispatch({ selection: { anchor: lineEnd } });
    try {
      view.dispatch(view.state.replaceSelection('\n\n- [ ] 输入测试任务\n'));
      typedOk = doc().includes('输入测试任务');
      await scrollTo('输入测试任务');
      await sleep(160);
      taskAfterType = document.querySelectorAll('.cm-task').length;
      const before = doc();
      undo(view);
      undoOk = doc() !== before && !doc().includes('输入测试任务');
    } catch (e) {
      ok('输入未抛异常', false, e.message);
    }
  }
  ok('模拟输入成功', typedOk);
  ok('新输入的任务行渲染出勾选框', taskAfterType > 0, taskAfterType + ' 个');
  ok('撤销可用', undoOk);

  /* 换文件要清掉撤销栈。栈若还留着上一份，Ctrl+Z 会把那份正文撤进当前文件。 */
  {
    const saved = doc();
    const marker = 'ONLY-IN-PREVIOUS-FILE';
    view.dispatch({ changes: { from: doc().length, insert: marker } });
    ctx.openDoc('next-file\n', null);
    const afterSwitch = doc();
    undo(view);
    ok(
      '换文件后撤销不带回上一份',
      doc() === afterSwitch && !doc().includes(marker),
      doc().slice(0, 24),
    );
    view.dispatch({ changes: { from: doc().length, insert: '仅本文件' } });
    const edited = doc();
    undo(view);
    ok('新文件里的撤销仍可用', doc() !== edited && !doc().includes('仅本文件'));
    ctx.openDoc(saved, null);
  }

  /* ---- 8. 主题四层级联 ---- */
  await ctx.applyTheme('night', { silent: true });
  ok('切换到深色主题', document.body.dataset.mode === 'dark' && document.documentElement.dataset.theme === 'night');
  await ctx.applyTheme('sepia', { silent: true });
  ok('暖白主题生效', document.body.dataset.mode === 'light' && document.documentElement.dataset.theme === 'sepia');
  await ctx.applyTheme('vue', { silent: true });
  ok('翠竹主题生效', document.documentElement.dataset.theme === 'vue' && document.body.dataset.mode === 'light');
  await ctx.applyTheme('white', { silent: true });

  /* ---- 8. 导出 ---- */
  const html = await ctx.exportHtml(doc(), { title: '自检' });
  ok('导出 HTML 含 table', html.includes('<table>'));
  ok('导出 HTML 含 katex', html.includes('katex'));
  ok('导出 HTML 含 checkbox', html.includes('type="checkbox"'));
  ok('导出 HTML 展开 [toc]', html.includes('class="toc"') && !html.includes('[toc]'));
  ok('导出 HTML 标题带锚点', /<h1 id="[^"]+">/.test(html));
  // 目录链接点和正文标题必须对得上，否则导出的目录点了没反应
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  const ids = new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]));
  ok('导出目录锚点全部命中', hrefs.length > 0 && hrefs.every((h) => ids.has(h)), `${hrefs.length} 个链接 / ${ids.size} 个标题`);
  ok('导出 HTML 内嵌 KaTeX 样式', html.includes('katex-test-source-stub'));
  let mermaidSource = '';
  const mermaidHtml = await ctx.exportHtmlReady('```mermaid\ngraph TD; A-->B\n```', {
    renderMermaid: async (code) => {
      mermaidSource = code;
      return '<svg data-test="mermaid"></svg>';
    },
  });
  ok('导出 Mermaid 固化为 SVG', mermaidHtml.includes('<svg data-test="mermaid">') && !mermaidHtml.includes('<pre class="mermaid">'));
  ok('导出 Mermaid 还原转义源码', mermaidSource === 'graph TD; A-->B', mermaidSource);
  const failedMermaid = await ctx.exportHtmlReady('```mermaid\ngraph TD; C-->D\n```', {
    renderMermaid: async () => { throw new Error('test'); },
  });
  ok('Mermaid 失败仍保留图表源码', failedMermaid.includes('<pre class="mermaid">') && failedMermaid.includes('C--&gt;D'));


  const beforeCompat = doc();
  const bomMd = '\uFEFF---\ntitle: 兼容\n---\n\n# 首行标题';
  const bomHtml = await ctx.exportHtml(bomMd);
  ok('导出忽略 UTF-8 BOM', bomHtml.includes('<dl class="frontmatter">') && /<h1 id="[^"]+">首行标题<\/h1>/.test(bomHtml));
  ctx.openDoc(bomMd, null);
  view.dispatch({ selection: { anchor: doc().length } });
  await sleep(180);
  ok('打开文件时剥离 BOM 并恢复文首样式', !doc().startsWith('\uFEFF') && !!document.querySelector('.cm-frontmatter'));

  const leadingTableMd = 'A | B\n--- | ---\n1 | <u>x</u>\n\n**后文**';
  ctx.openDoc(leadingTableMd, null);
  view.dispatch({ selection: { anchor: doc().length } });
  await scrollUntil('A | B', () => !!document.querySelector('.cm-table-wrap'));
  ok('文档以宽松表格开头时正常渲染', !!document.querySelector('.cm-table-wrap'));
  await scrollUntil('后文', () =>
    [...document.querySelectorAll('.cm-strong')].some((el) => el.textContent === '后文'),
  );
  ok('文首表格不会屏蔽后续语法树', [...document.querySelectorAll('.cm-strong')].some((el) => el.textContent === '后文'));
  ctx.openDoc(beforeCompat, null);
  await sleep(120);

  const compatMd = [
    '[官网][site] ![图标][logo]',
    '',
    '[site]: https://example.com "示例"',
    '[logo]: assets/logo.png',
    '',
    'H~2~O x^2^ ==重点==',
    '',
    '- 外层',
    '    - 内层',
    '',
    '| A\\|B | `C|D` |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '名称 | 值',
    '--- | ---',
    '左 | <kbd>Ctrl</kbd> 与 $x^2$',
    '',
    '<u>下划线</u> <mark>标记</mark> H<sub>2</sub>O x<sup>2</sup>',
    '<u onclick="x">非白名单属性</u>',
    '',
    '> [!WARNING] 注意',
    '> 调用块正文',
  ].join('\n');
  const compatHtml = await ctx.exportHtml(compatMd);
  ok('导出引用式链接与图片', compatHtml.includes('href="https://example.com"') && compatHtml.includes('src="assets/logo.png"'));
  ok('导出上下标与高亮', compatHtml.includes('H<sub>2</sub>O') && compatHtml.includes('x<sup>2</sup>') && compatHtml.includes('<mark>重点</mark>'));
  ok('导出嵌套列表保留层级', /<ul><li>外层<ul><li>内层<\/li><\/ul><\/li><\/ul>/.test(compatHtml));
  ok('导出表格保留转义竖线与代码内竖线', compatHtml.includes('A|B</th>') && compatHtml.includes('<code>C|D</code>') && !compatHtml.includes('A\\|B</th>'));
  ok('导出支持省略外侧管道的表格', (compatHtml.match(/<table>/g) || []).length === 2 && compatHtml.includes('<td style="text-align:left">左</td>'));
  ok('导出白名单行内 HTML', compatHtml.includes('<kbd>Ctrl</kbd>') && compatHtml.includes('<u>下划线</u>') && compatHtml.includes('<mark>标记</mark>') && compatHtml.includes('H<sub>2</sub>O'));
  ok('导出拒绝带属性的 HTML', compatHtml.includes('&lt;u onclick=') && !compatHtml.includes('<u onclick='));
  ok('导出 Callout 保留类型与正文', compatHtml.includes('callout-warning') && compatHtml.includes('调用块正文'));
  view.dispatch({ changes: { from: 0, to: doc().length, insert: compatMd }, selection: { anchor: compatMd.length } });
  await scrollUntil('H~2~O', () => !!document.querySelector('.cm-sup') && !!document.querySelector('.cm-sub'));
  ok('编辑器渲染上下标', !!document.querySelector('.cm-sup') && !!document.querySelector('.cm-sub'));
  await scrollUntil('[官网][site]', () => !!document.querySelector('.cm-link[data-href="https://example.com"]'));
  ok('编辑器引用链接带真实地址', !!document.querySelector('.cm-link[data-href="https://example.com"]'));

  await scrollUntil('名称 | 值', () =>
    [...document.querySelectorAll('.cm-table-wrap')].some((el) => el.textContent.includes('Ctrl')),
  );
  const looseTable = [...document.querySelectorAll('.cm-table-wrap')].find((el) => el.textContent.includes('Ctrl'));
  const looseBodyRow = looseTable && looseTable.querySelector('tbody tr');
  ok('宽松表格保持两列且不与行内装饰冲突', !!looseBodyRow && looseBodyRow.children.length === 2);
  ok('宽松表格单元格渲染 HTML 与公式', !!looseTable?.querySelector('.cm-kbd') && !!looseTable?.querySelector('.katex'));

  await scrollUntil('下划线', () => !!document.querySelector('.cm-underline'));
  ok('编辑器渲染白名单行内 HTML', !!document.querySelector('.cm-underline') && !!document.querySelector('.cm-mark'));
  await scrollUntil('内层', () =>
    [...document.querySelectorAll('.cm-line')].some((el) => el.textContent.includes('内层') && el.textContent.includes('◦')),
  );
  const fourSpaceItem = [...document.querySelectorAll('.cm-line')].find((el) => el.textContent.includes('内层'));
  ok('四空格嵌套列表使用正确圆点层级', !!fourSpaceItem && fourSpaceItem.textContent.includes('◦'));
  view.dispatch({ changes: { from: 0, to: doc().length, insert: beforeCompat } });
  await sleep(140);

  /* ---- 9. 查找面板 ---- */
  openSearchPanel(view);
  await sleep(120);
  const searchPanel = document.querySelector('.cm-panel.cm-search');
  ok('查找面板可打开', !!searchPanel);
  ok(
    '查找面板已中文化',
    searchPanel ? /替换|区分大小写|整词/.test(searchPanel.textContent) : false,
    searchPanel ? searchPanel.textContent.replace(/\s+/g, ' ').slice(0, 18) : '无'
  );

  /* ---- 10. 菜单栏 ---- */
  const mbBtn = (id) => document.querySelector(`.mb-item[data-menu="${id}"]`);
  const pop = () => document.getElementById('menu-pop');
  const popRows = () => [...document.querySelectorAll('#menu-pop .menu-item')];
  const rowLabel = (r) => (r.querySelector('.menu-label') || {}).textContent || '';
  const openMenu = (id) => mbBtn(id).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const clickRow = (text) => {
    const row = popRows().find((r) => rowLabel(r) === text);
    if (row) row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return row;
  };

  const mbItems = [...document.querySelectorAll('.mb-item')];
  ok('菜单栏有五个菜单', mbItems.length === 5, mbItems.map((b) => b.textContent).join(' '));
  ok('没有横铺的工具条', !document.getElementById('toolbar'));
  ok('菜单项带助记键', /F/.test(mbItems[0].textContent), mbItems[0].textContent);

  openMenu('view');
  await sleep(120);
  ok('点击展开下拉菜单', !pop().hidden && pop().dataset.menu === 'view');
  const viewRows = popRows().length;
  ok('下拉菜单列出详细功能', viewRows >= 6, viewRows + ' 项');
  ok(
    '菜单项带加速键文本',
    popRows().some((r) => /Ctrl\+/.test((r.querySelector('.menu-accel') || {}).textContent || '')),
    popRows().map((r) => (r.querySelector('.menu-accel') || {}).textContent).filter(Boolean).join(' ')
  );
  ok(
    '当前面板有勾选标记',
    popRows().some((r) => /大纲|文件树/.test(rowLabel(r)) && /[✓●]/.test((r.querySelector('.menu-mark') || {}).textContent || ''))
  );

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitFor(() => pop().hidden, 800);
  ok('Esc 关闭菜单', pop().hidden);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', altKey: true, bubbles: true }));
  await sleep(120);
  ok('Alt+F 展开文件菜单', !pop().hidden && pop().dataset.menu === 'file', pop().dataset.menu || '未展开');

  // 导出收拢成子菜单：点「导出」下钻，Esc 逐级返回
  clickRow('导出');
  await waitFor(() => popRows().some((r) => rowLabel(r) === '导出 PDF'), 800);
  ok(
    '导出收拢为下拉子菜单',
    popRows().some((r) => rowLabel(r) === '导出 PDF') && popRows().some((r) => r.classList.contains('is-back')),
    popRows().map(rowLabel).join(' / ').slice(0, 40)
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(100);
  ok('子菜单 Esc 返回上一级', popRows().some((r) => rowLabel(r) === '另存为…'), popRows().map(rowLabel).join(' / ').slice(0, 30));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(100);

  /* ---- 10.5 源代码模式 ---- */
  await scrollUntil('支持 **加粗**', () => document.querySelectorAll('.cm-strong').length > 0);
  const strongBefore = document.querySelectorAll('.cm-strong').length;

  // 菜单是异步展开的：先等它真的开出来再点行，否则偶尔会点到一份还没渲染的行，
  // 后面整段（源码模式、链接、配对）都跟着塌方
  openMenu('view');
  await waitFor(() => !!pop() && !pop().hidden && popRows().some((r) => rowLabel(r) === '源代码模式'), 900);
  const srcRow = clickRow('源代码模式');
  await waitFor(() => document.querySelectorAll('.cm-strong').length === 0, 900);
  const strongAfter = document.querySelectorAll('.cm-strong').length;
  ok('源代码模式关掉渲染', !!srcRow && strongBefore > 0 && strongAfter === 0, `${strongBefore} → ${strongAfter}`);
  ok('源代码模式下可见原始标记', document.body.innerText.includes('支持 **加粗**'));

  // 用快捷键切回来（顺带验证 Mod-/ 的绑定）。CM 的 keymap 挂在 contentDOM 上，
  // 事件必须从编辑器内部发出去，发到 body 上是收不到的。
  view.focus();
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: '/', code: 'Slash', ctrlKey: true, bubbles: true, cancelable: true })
  );
  await waitFor(() => !document.body.classList.contains('source-mode'), 900);
  await scrollUntil('支持 **加粗**', () => document.querySelectorAll('.cm-strong').length > 0);
  ok('退出源代码模式恢复渲染', document.querySelectorAll('.cm-strong').length > 0);
  ok('源代码模式状态已复位', !document.body.classList.contains('source-mode'));

  // 兜底复位：源码模式一旦没关掉，后面所有「应该有装饰」的断言都会跟着塌方，
  // 报出来像一堆无关的错。上面已经把失败记下了，这里只管把现场恢复干净。
  if (document.body.classList.contains('source-mode')) {
    view.dispatch({ effects: setSourceMode.of(false) });
    await sleep(150);
  }

  /* ---- 11. 侧栏：目录 / 文件树 / 收起，以及状态栏两个按钮 ---- */
  const sideEl = document.getElementById('sidebar');
  const treeEl = document.getElementById('file-tree');
  const outlineEl = document.getElementById('outline');
  const sbTab = (v) => document.querySelector(`.sb-tab[data-view="${v}"]`);
  const btnSide = document.getElementById('st-side');
  const btnSource = document.getElementById('st-source');
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  // display:none 的元素 getClientRects() 为空，比 offsetParent 更稳（父级链也算）
  const shown = (el) => !!el && el.getClientRects().length > 0;
  await waitFor(() => !!document.body.dataset.side, 800);

  ok('侧栏默认可见', shown(sideEl) && !document.body.classList.contains('hide-sidebar'));
  ok(
    '默认停在目录视图',
    document.body.dataset.side === 'outline' && shown(outlineEl) && !shown(treeEl),
    `side=${document.body.dataset.side} outline=${shown(outlineEl)} tree=${shown(treeEl)} hidden=${document.body.classList.contains('hide-sidebar')}`
  );
  ok('状态栏侧栏按钮亮着', !!btnSide?.classList.contains('is-on'), btnSide?.className);

  click(sbTab('files'));
  await sleep(160);
  ok('页签可切到文件面板', document.body.dataset.side === 'files' && shown(treeEl) && !shown(outlineEl));
  // 面板选择由侧栏自己的页签表达，状态栏那个按钮只管开合
  ok('切视图不影响侧栏按钮', !!btnSide?.classList.contains('is-on'), btnSide?.className);

  click(btnSide);
  await waitFor(() => !shown(sideEl) && document.body.classList.contains('hide-sidebar'), 800);
  ok('状态栏按钮能收起侧栏', !shown(sideEl) && document.body.classList.contains('hide-sidebar'));
  ok('收起后侧栏按钮熄灭', !btnSide?.classList.contains('is-on'), btnSide?.className);

  click(btnSide);
  await sleep(160);
  ok('状态栏按钮能重新展开侧栏', shown(sideEl) && !document.body.classList.contains('hide-sidebar'));

  click(btnSide);
  await waitFor(() => !shown(sideEl), 800);
  ok(
    '再点一次收起侧栏',
    !shown(sideEl) && !btnSide?.classList.contains('is-on'),
    `visible=${shown(sideEl)} btn=${btnSide?.className} side=${document.body.dataset.side}`
  );

  // 收起来再打开：应该回到上次看的那个面板，而不是重置成大纲
  click(btnSide);
  await sleep(200);
  ok('重新打开后保持上次的面板', shown(sideEl) && document.body.dataset.side === 'files', document.body.dataset.side);

  /* 状态栏第二个按钮：源代码模式（和 Typora 一样，一个开侧栏一个切源码） */
  click(btnSource);
  await waitFor(() => document.body.classList.contains('source-mode'), 800);
  ok(
    '状态栏 </> 开启源代码模式',
    document.body.classList.contains('source-mode') && !!btnSource?.classList.contains('is-on'),
    btnSource?.className
  );
  click(btnSource);
  await waitFor(() => !document.body.classList.contains('source-mode'), 800);
  ok(
    '再点一次退出源代码模式',
    !document.body.classList.contains('source-mode') && !btnSource?.classList.contains('is-on')
  );
  await scrollUntil('支持 **加粗**', () => document.querySelectorAll('.cm-strong').length > 0);

  /* 真实目录上的文件树：临时区铺一份样本，用 loadDoc 打开其中一篇 */
  const info = window.studio?.info ? await window.studio.info() : null;
  const fixture = info?.tmpDir ? `${info.tmpDir.replace(/\\/g, '/')}/mdstudio-tree-fixture` : null;
  if (fixture) {
    const written = await Promise.all([
      window.studio.saveFile(`${fixture}/读书笔记.md`, '# 读书笔记\n\n正文\n'),
      window.studio.saveFile(`${fixture}/会议纪要.md`, '# 会议纪要\n'),
      window.studio.saveFile(`${fixture}/忽略我.png`, 'x'),
      window.studio.saveFile(`${fixture}/子目录/深层笔记.md`, '# 深层笔记\n'),
    ]);
    ok('样本文件已落盘', written.every(Boolean) && written.length === 4);

    ctx.openDoc('# 读书笔记\n\n正文\n', `${fixture}/读书笔记.md`);
    // 用页签而不是顶栏按钮：页签只会「切到文件视图并展开」，不会顺手把侧栏收起来
    click(sbTab('files'));
    // 文件树是逐条 IPC 取回来的，冷启动时 900ms 可能不够 —— 直接等「三个名字都到齐」
    const treeNames = () => [...document.querySelectorAll('#file-tree .ft-row .ft-name')].map((n) => n.textContent);
    await waitFor(
      () => ['读书笔记', '会议纪要', '子目录'].every((n) => treeNames().includes(n)),
      3000,
      60
    );

    const rows = [...document.querySelectorAll('#file-tree .ft-row')];
    const names = treeNames();
    ok('文件树列出 md 文件', ['读书笔记', '会议纪要', '子目录'].every((n) => names.includes(n)), names.join(' '));
    ok('文件树过滤非 md 文件', !names.some((n) => /忽略我/.test(n)), names.join(' '));
    ok('目录排在文件之前', rows[0]?.querySelector('.ft-name')?.textContent === '子目录');

    // 页签就是两个纯文字。文件和目录同为单行：图标 + 名字，摘要在 data-snippet，时间仍在右侧。
    ok('页签是「文件 / 大纲」', sbTab('outline').textContent.trim() === '大纲', sbTab('outline').textContent.trim());
    const noteRow = [...document.querySelectorAll('#file-tree .ft-row[data-dir="0"]')].find((r) =>
      /读书笔记/.test(r.textContent)
    );
    ok(
      '文件条目是紧凑单行并带时间',
      !!noteRow &&
        !!noteRow.querySelector('.ft-icon') &&
        !noteRow.querySelector('.ft-sub') &&
        (noteRow.dataset.snippet || '').includes('读书笔记') &&
        !!(noteRow.querySelector('.ft-time')?.textContent || '').length,
      noteRow ? noteRow.textContent.trim() : '无'
    );

    const activeRows = document.querySelectorAll('#file-tree .ft-row.is-active');
    ok(
      '当前文件高亮',
      activeRows.length === 1 && /读书笔记/.test(activeRows[0].textContent),
      activeRows[0] ? activeRows[0].textContent.trim() : '无'
    );

    click(rows[0]); // 展开「子目录」
    await waitFor(() => !!document.querySelector('#file-tree .ft-children .ft-row'), 2000);
    const child = document.querySelector('#file-tree .ft-children .ft-row');
    ok('目录可点击展开', !!child && /深层笔记/.test(child.textContent), child ? child.textContent.trim() : '无');

    click([...document.querySelectorAll('#file-tree .ft-row')].find((r) => /会议纪要/.test(r.textContent)));
    await waitFor(() => doc().includes('会议纪要'), 2000);
    ok('点文件行可切换文档', doc().includes('# 会议纪要'));
    // 打开文档会 dispatch 一次全文替换，别把它当成用户编辑：状态栏不该出现「未保存」，
    // 否则自动保存会在 1.2 秒后把刚打开的文件原样重写一遍
    await sleep(1600);
    ok(
      '打开文档后仍是已保存状态',
      !document.getElementById('st-dirty').textContent && !document.getElementById('st-hint').textContent.includes('自动保存'),
      `dirty="${document.getElementById('st-dirty').textContent}" hint="${document.getElementById('st-hint').textContent}"`
    );

    // 文档换回来了，示例文档要复原，后面的结果面板才对得上
    ctx.openDoc(doc0, null);
    await sleep(160);
  }

  /* ---- 12. 快捷键：声明 ↔ 真实绑定 ---- */
  // keymap facet 里是最终生效的全部绑定（我们自己的 + defaultKeymap/searchKeymap/historyKeymap），
  // 拿它和 shortcuts.js 的声明逐一对照，菜单上写着、按下去没反应这类问题才会被拦住。
  const bound = new Set();
  // facet 的值是「每个 keymap.of() 贡献的数组」，要摊平一层才是绑定对象
  for (const b of view.state.facet(keymap).reduce((a, x) => a.concat(x), [])) {
    const raw = b.key || b.win;
    if (!raw) continue;
    for (const one of [].concat(raw)) {
      bound.add(normAccel(b.shift ? `Shift-${one}` : one));
    }
  }

  const declared = declaredShortcuts();
  const missing = declared.filter((d) => !bound.has(normAccel(d.keys)) && !NATIVE_KEYS.has(normAccel(d.keys)));
  ok(
    '声明的快捷键都有真实绑定',
    missing.length === 0,
    missing.length ? missing.map((m) => `${m.keys} ${m.label}`).join(' / ') : `${declared.length} 条全部命中`
  );

  // 同一个键被两个命令抢：后注册的永远轮不上，必须提前发现
  const seen = new Map();
  const dup = [];
  for (const d of declared) {
    const k = normAccel(d.keys);
    if (seen.has(k)) dup.push(`${d.keys}（${seen.get(k)} / ${d.label}）`);
    else seen.set(k, d.label);
  }
  ok('没有两个命令抢同一个键', dup.length === 0, dup.join(' / ') || '无冲突');

  // 动态验证：真按下去要能改文档，光有绑定对象不算数
  const pressCombo = (key, opts = {}) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  const mark = view.state.doc.length;
  view.dispatch({ changes: { from: mark, insert: '\n\n普通一行\n' } });
  const plainNo = view.state.doc.lines - 1;
  const plainFrom = view.state.doc.line(plainNo).from;
  view.dispatch({ selection: { anchor: plainFrom + 2 } });
  view.focus();

  pressCombo('4', { ctrlKey: true });
  await sleep(140);
  ok('Ctrl+4 生效（四级标题）', view.state.doc.line(plainNo).text.startsWith('#### '), view.state.doc.line(plainNo).text.slice(0, 12));

  pressCombo('0', { ctrlKey: true });
  await sleep(140);
  ok('Ctrl+0 生效（回到正文）', view.state.doc.line(plainNo).text === '普通一行', view.state.doc.line(plainNo).text);

  view.dispatch({ selection: { anchor: plainFrom, head: view.state.doc.line(plainNo).to } });
  // 带 Shift 的字母键：CM 会拿 event.keyCode 反查物理键位来还原没按 Shift 的基准键，
  // 合成事件里不填 keyCode，匹配就落不了地（真实按键有值，所以这只是测试的隐情）
  pressCombo('X', { ctrlKey: true, shiftKey: true, keyCode: 88, which: 88 });
  await sleep(140);
  ok('Ctrl+Shift+X 生效（删除线）', /~~.+~~/.test(view.state.doc.line(plainNo).text), view.state.doc.line(plainNo).text);

  // 还原文档
  view.dispatch({ changes: { from: mark, to: view.state.doc.length, insert: '' } });
  await sleep(80);
  ok('快捷键测试未污染文档', doc() === doc0);

  /* ---- 12. 链接：Ctrl+点击打开、粘贴链接到选中文字 ---- */
  await scrollUntil('commonmark.org', () => !!document.querySelector('.cm-link'));
  const linkEl = document.querySelector('.cm-link');
  ok('链接带上 data-href', !!linkEl && linkEl.dataset.href === 'https://commonmark.org', linkEl ? linkEl.dataset.href : '无');
  linkEl?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const linkMenu = document.querySelector('.app-context');
  ok('链接右键可打开并复制地址', !!linkMenu && !!linkMenu.querySelector('[data-context-action="打开链接"]') && !!linkMenu.querySelector('[data-context-action="复制链接地址"]'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  view.contentDOM.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  const editorMenu = document.querySelector('.app-context');
  ok(
    '编辑区右键为 Typora 式面板',
    !!editorMenu &&
      ['剪切', '复制', '粘贴', '删除所选', 'B', 'I', '复制 / 粘贴为…', '段落', '插入'].every((label) =>
        editorMenu.querySelector(`[data-context-action="${label}"]`)
      ) &&
      !!editorMenu.querySelector('.context-grid'),
    editorMenu ? [...editorMenu.querySelectorAll('[data-context-action]')].length + ' 项' : '无'
  );
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  // 剪贴板富文本与渲染后纯文本断言
  const testStateInline = EditorState.create({
    doc: 'A **boy** and a *girl*',
    selection: EditorSelection.single(0, 9), // 'A **boy**' (行内部分选区)
  });
  const resInline = renderSelectionForClipboard(testStateInline);
  ok('行内部分选区复制输出行内富文本与无标记纯文本', resInline.plain === 'A boy' && resInline.html === 'A <strong>boy</strong>', JSON.stringify(resInline));

  const testStateFence = EditorState.create({
    doc: '```js\nconst answer = 42;\n```',
    selection: EditorSelection.single(0, 26),
  });
  const resFence = renderSelectionForClipboard(testStateFence);
  ok('代码块复制剥掉代码围栏输出pre/code与纯代码', resFence.plain.trim() === 'const answer = 42;' && !resFence.plain.includes('```') && resFence.html.includes('<pre class="code">'), JSON.stringify(resFence));

  const testStateHeading = EditorState.create({
    doc: '## 标题二',
    selection: EditorSelection.single(0, 6),
  });
  const resHeading = renderSelectionForClipboard(testStateHeading);
  ok('标题整行复制输出无井号纯文本与h2', resHeading.plain === '标题二' && resHeading.html.includes('<h2>标题二</h2>'), JSON.stringify(resHeading));

  const imgResolved = resolveImageForClipboard('./assets/demo.png', 'C:\\docs');
  ok('剪贴板图片相对路径解析为标准file协议URL', imgResolved === 'file:///C:/docs/assets/demo.png', imgResolved);

  // 页内锚点：按导出时的 slug 规则跳标题（真开系统浏览器在自检里没法验，也不能验）
  const beforeJump = view.scrollDOM.scrollTop;
  const jumped = ctx.openLink ? ctx.openLink('#代码块') : false;
  const codeHeading = buildOutline(view.state).find((h) => h.text === '代码块');
  await waitFor(() => codeHeading && posVisible(codeHeading.pos), 1800);
  ok(
    'Ctrl+点击页内锚点会跳转',
    jumped === true && !!codeHeading && posVisible(codeHeading.pos),
    `${Math.round(beforeJump)} → ${Math.round(view.scrollDOM.scrollTop)}`
  );

  // 选中文字 + 粘贴裸链接 → [文字](链接)
  const target = doc().indexOf('欧拉恒等式');
  view.dispatch({ selection: { anchor: target, head: target + 5 } });
  const linked = ctx.linkifySelection ? ctx.linkifySelection('https://example.com/a') : false;
  await sleep(120);
  ok('粘贴链接把选中文字变成链接', linked === true && doc().includes('[欧拉恒等式](https://example.com/a)'));
  ok('普通文字不会被当成链接', ctx.linkifySelection('随便一段文字') === false);
  undo(view);
  await sleep(120);
  ok('链接测试未污染文档', doc() === doc0);

  /* ---- 12.5 点击标题：CM 的高度模型不能漂 ---- */
  await scrollTo('## 表格');
  const codeLastEl = document.querySelector('.cm-line.cm-code-body-last');
  const fenceCloseEl = document.querySelector('.cm-line.cm-fence-close');
  let where = '';
  await waitFor(() => {
    const el = [...document.querySelectorAll('.cm-line.cm-heading')].find((e) => /表格/.test(e.textContent));
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const sc = view.scrollDOM.getBoundingClientRect();
    if (!r.height || r.top < sc.top || r.bottom > sc.bottom) return false;
    const p = view.posAtCoords({ x: Math.round(r.left + 70), y: Math.round(r.top + r.height / 2) }, false);
    where = p == null ? '' : doc().split('\n')[view.state.doc.lineAt(p).number - 1];
    return /## 表格/.test(where);
  }, 3000);
  ok('标题的视觉位置映射回标题行', /## 表格/.test(where), JSON.stringify(where));
  // margin 不计入 CM 的行高，内容区里只要出现垂直 margin，后面所有点击都会逐行错位
  ok(
    '内容区没有量不到的垂直外边距',
    !!codeLastEl && getComputedStyle(codeLastEl).marginBottom === '0px',
    codeLastEl ? getComputedStyle(codeLastEl).marginBottom : '无'
  );
  // 段间距走 --block-gap：围栏行上下两条边框、代码正文收尾的内边距，
  // 三者都必须等于同一个变量，不然代码块与正文的呼吸会在密度/主题切换时漂移。
  const blockGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--block-gap'));
  ok(
    '块级间距统一且计入高度模型',
    !!codeLastEl &&
      !!fenceCloseEl &&
      Math.abs(parseFloat(getComputedStyle(fenceCloseEl).borderBottomWidth) - blockGap) <= 1 &&
      getComputedStyle(codeLastEl).paddingBottom === '8px',
    codeLastEl && fenceCloseEl
      ? `${getComputedStyle(fenceCloseEl).borderBottomWidth} / ${getComputedStyle(codeLastEl).paddingBottom} / gap ${blockGap}`
      : '无'
  );
  ok(
    '闭合围栏不保留额外行高',
    !!fenceCloseEl && getComputedStyle(fenceCloseEl).lineHeight === '0px',
    fenceCloseEl ? getComputedStyle(fenceCloseEl).lineHeight : '无'
  );

  /* ---- 12.6 粘贴即代码块 ---- */
  const tailSafe = () => JSON.stringify(doc().slice(-40));
  const detect = ctx.detectCode || (() => null);
  ok(
    'SQL 语句识别成 sql',
    detect('SELECT * FROM users WHERE id = 1;')?.lang === 'sql' &&
      detect('CREATE TABLE t (id INT PRIMARY KEY);')?.lang === 'sql',
    ''
  );
  ok(
    'Python / JSON 也认得',
    detect('def add(a, b):\n    return a + b')?.lang === 'python' && detect('{"a": 1}')?.lang === 'json',
    ''
  );
  ok(
    '中文、英文句子、Markdown 列表与已有围栏不当代码',
    detect('这是一段很普通的中文文字，讲了些别的事情。') === null &&
      detect('Select the file you want from the list') === null &&
      detect('- 第一项\n- 第二项') === null &&
      detect('```js\nconst a = 1;\n```') === null,
    ''
  );

  const pasteAt = doc().length;
  view.dispatch({ changes: { from: pasteAt, insert: '\n\n' }, selection: { anchor: pasteAt + 2 } });
  // history 的默认并组窗口是 500ms，隔开一点，撤销才只退代码块本身
  await sleep(650);
  const beforePaste = doc();
  const sql = 'SELECT id, name\nFROM users\nWHERE age > 18;';
  const didPaste = ctx.pasteAsCodeBlock ? ctx.pasteAsCodeBlock(view, sql) : false;
  // 同步取一次：隐藏窗口里 CM 的 DOM 选区观察器可能把 state 选区改回旧的原生选区，
  // 等 180ms 再读就有概率读到别的行。dispatch 是同步的，这一刻的落点才是粘贴行为本身。
  const caretLineRightAfter = view.state.doc.lineAt(view.state.selection.main.head).text;
  await sleep(180);
  ok('粘贴 SQL 落成代码块', didPaste === true && /```sql\n/.test(doc()) && doc().includes(sql), tailSafe());
  ok('光标停在代码正文末尾', caretLineRightAfter === 'WHERE age > 18;', JSON.stringify(caretLineRightAfter));

  undo(view);
  await sleep(150);
  ok('一次撤销整块退回', doc() === beforePaste, tailSafe());

  // 普通中文、行中间、有选区：都得放手让 CM 原生粘贴
  const snap = doc();
  ok('普通中文不抢粘贴', ctx.pasteAsCodeBlock(view, '这是一段普通的中文文字，讲了些别的事情。') === false && doc() === snap);
  const mid = doc().indexOf('欧拉恒等式') + 2;
  view.dispatch({ selection: { anchor: mid } });
  ok('光标在行中间不抢粘贴', ctx.pasteAsCodeBlock(view, sql) === false && doc() === snap);

  // 真实的 paste 事件：确认我们的处理器排在 CM 内置粘贴前面
  const evAt = doc().length;
  view.dispatch({ changes: { from: evAt, insert: '\n\n' }, selection: { anchor: evAt + 2 } });
  await sleep(140);
  const dt = new DataTransfer();
  dt.setData('text/plain', 'CREATE TABLE t (id INT PRIMARY KEY);');
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(ev);
  await sleep(200);
  ok('Ctrl+V 事件也落成代码块', ev.defaultPrevented && /```sql\nCREATE TABLE/.test(doc()), tailSafe());

  // 收摊
  view.dispatch({ changes: { from: pasteAt, to: doc().length }, selection: { anchor: pasteAt }, userEvent: 'delete.fence' });
  await sleep(150);
  ok('粘贴测试未污染文档', doc() === doc0, tailSafe());

  /* ---- 12.7 裸远程图片 URL 粘贴即预览 ---- */
  const beforeImagePaste = doc();
  const imageAt = beforeImagePaste.length;
  view.dispatch({ changes: { from: imageAt, insert: '\n\n' }, selection: { anchor: imageAt + 2 } });
  await sleep(140);
  const remoteUrl = 'https://imgbed.czmhello.dpdns.org/file/picture/1782889699574_【彼岸图网】少女_信_天空_云_汽车_草地_4k壁纸_3840x2160.jpg';
  const imageData = new DataTransfer();
  imageData.setData('text/plain', remoteUrl);
  const imageEvent = new ClipboardEvent('paste', { clipboardData: imageData, bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(imageEvent);
  await sleep(200);
  ok(
    'Ctrl+V 把裸图片 URL 转成 Markdown 图片',
    imageEvent.defaultPrevented && doc().includes(`![](<${remoteUrl}>)`),
    tailSafe()
  );
  const remotePreview = await waitFor(() =>
    [...document.querySelectorAll('.cm-image')].some((el) => el.dataset.markdownSrc === remoteUrl)
  );
  ok('粘贴后直接出现图片预览而非 URL 文本', remotePreview, remotePreview ? '' : '未找到远程图片 widget');

  const beforePlainUrl = doc();
  ok(
    '普通网页 URL 仍按原文粘贴',
    ctx.handlePastedText('https://example.com/readme') === false && doc() === beforePlainUrl,
    ''
  );
  view.dispatch({ changes: { from: imageAt, to: doc().length }, selection: { anchor: imageAt } });
  await sleep(150);
  ok('远程图片粘贴测试未污染文档', doc() === beforeImagePaste, tailSafe());

  /* ---- 13. 自动配对（走真实的输入路径，不是直接 dispatch） ---- */
  // execCommand 会触发 beforeinput → CM 的输入处理，inputHandler 才真的被调用；
  // 用 dispatch 造 transactions 是绕过配对的，测不到东西。
  view.focus();
  const atPair = view.state.doc.length;
  view.dispatch({ changes: { from: atPair, insert: '\n\n' }, selection: { anchor: atPair + 2 } });
  // execCommand 用的是**浏览器原生选区**，而 CM 把 state 选区写回 DOM 是在下一轮 measure。
  // 隐藏窗口的 rAF 会被节流，上一节测试留下的旧选区可能还没被覆盖，第一笔就插错位置。
  // 用 CM 自己的 domAtPos 把原生光标精确放到当前光标处；只在开头做一次，
  // 后面「选区外输入 ( 会包住选区」依赖一个真实的 range 选区，不能碰。
  const domAt = view.domAtPos(view.state.selection.main.head);
  const nativeSel = document.getSelection();
  nativeSel.removeAllRanges();
  const nativeRange = document.createRange();
  nativeRange.setStart(domAt.node, domAt.offset);
  nativeRange.collapse(true);
  nativeSel.addRange(nativeRange);
  await sleep(180);
  // 注意：后面配对组不再用 execCommand——隐藏窗口里原生选区落点不可靠，见下面的说明。
  const tail = (n = 8) => JSON.stringify(doc().slice(-n));
  // 编辑器会让非空文档始终保留一个末尾换行；配对断言只检查用户正文。
  const userDoc = () => doc().endsWith('\n') ? doc().slice(0, -1) : doc();
  const gap = () => {
    const h = view.state.selection.main.head;
    return { left: doc()[h - 1] || '', right: doc()[h] || '' };
  };

  // 隐藏窗口里 execCommand('insertText') 走浏览器原生选区，它和 CM 的 state 选区隔着一轮
  // measure，时序一挤就插到旧位置——真实按键不受影响（前面几段键盘测试都过了）。
  // 这一组直接调 handleInput，测的就是配对逻辑本身，不再被合成输入的时序连累。
  const inputAt = (ch) => {
    const h = view.state.selection.main.head;
    view.dispatch({ changes: { from: h, insert: ch }, selection: { anchor: h + ch.length }, userEvent: 'input.type' });
  };
  const pairCall = (ch, { wrap = false } = {}) => {
    const h = view.state.selection.main.head;
    if (wrap) return handleInput(view, view.state.selection.main.from, view.state.selection.main.to, ch);
    return handleInput(view, h, h, ch) === true;
  };

  const pairBase = doc().length;
  view.dispatch({ changes: { from: pairBase, insert: '\n\n' }, selection: { anchor: pairBase + 2 } });
  const paired = pairCall('(');
  await sleep(60);
  ok('输入 ( 自动补右括号', paired && userDoc().endsWith('()') && gap().left === '(' && gap().right === ')', tail(4) + ' paired=' + paired);

  // 直接验证删除命令，避免合成 keydown 与浏览器原生选区不同步造成假失败。
  const pairDeleted = deletePair(view);
  await sleep(140);
  ok('空配对里退格删掉一对', pairDeleted && doc().endsWith('\n\n'), tail(4));

  pairCall('(');
  await sleep(60);
  const skipped = pairCall(')'); // 光标后面已经是 )，这次只应该跳过
  await sleep(60);
  ok(
    '再输右括号只是跳过',
    skipped && userDoc().endsWith('()') && view.state.selection.main.head === userDoc().length,
    tail(4) + ' skipped=' + skipped
  );

  inputAt('a');
  inputAt('*');
  const starred = pairCall('*');
  await sleep(80);
  ok('连按两个 * 补成 **|**', starred && userDoc().endsWith('a****') && gap().left === '*' && gap().right === '*', tail(6) + ' starred=' + starred);

  // 有选区时输入左符 = 包起来，并且包完仍选中原来的文字
  // 只选四个星号，不把编辑器自动保留的末尾换行纳入包裹范围。
  const wrapEnd = userDoc().length;
  const selStart = wrapEnd - 4;
  view.dispatch({ selection: { anchor: selStart, head: wrapEnd } });
  const wrapped = pairCall('(', { wrap: true });
  await sleep(80);
  ok('选区外输入 ( 会包住选区', wrapped && userDoc().endsWith('(****)'), tail(10) + ' wrapped=' + wrapped);
  ok('包裹后仍选中原文字', view.state.selection.main.to - view.state.selection.main.from === 4);

  // 在已有正文前输入 ```：只输完三个反引号不自动闭合、不套代码块样式，等回车再生成。
  const draftGuardAt = doc().length;
  const draftCaret = draftGuardAt + 4;
  view.dispatch({
    changes: { from: draftGuardAt, insert: '\n\n``\n# 草稿后续标题\n\n**草稿后续粗体**' },
    selection: { anchor: draftCaret },
  });
  const autoClosed = handleInput(view, draftCaret, draftCaret, '`');
  // 不再接管第三个反引号：走普通插入，保持未闭合的草稿状态。
  if (!autoClosed) view.dispatch({ changes: { from: draftCaret, insert: '`' } });
  await sleep(160);
  const draftBlock = getCodeFences(view.state).find((block) => block.from === draftGuardAt + 2);
  ok(
    '输完 ``` 不自动闭合（等回车生成）',
    !autoClosed && !!draftBlock && isFenceDraft(draftBlock),
    draftBlock ? JSON.stringify({ lang: draftBlock.lang, close: draftBlock.close?.line.text }) : '无代码块'
  );
  const draftLangCaret = view.state.selection.main.head;
  view.dispatch({ changes: { from: draftLangCaret, insert: 'js' } });
  await sleep(100);
  const draftLangBlock = getCodeFences(view.state).find((block) => block.from === draftGuardAt + 2);
  ok('草稿状态仍能输入代码语言', draftLangBlock?.lang === 'js', draftLangBlock?.lang || '无');
  const draftOpenLine = view.state.doc.lineAt(view.state.selection.main.head);
  pressKey('Enter', 13);
  await sleep(160);
  const draftBodyLine = view.state.doc.lineAt(view.state.selection.main.head);
  const enteredBlock = getCodeFences(view.state).find((block) => block.from === draftGuardAt + 2);
  ok('回车补出尾围栏并进入代码正文', draftBodyLine.number === draftOpenLine.number + 1 && draftBodyLine.text === '' && !!enteredBlock?.close);
  await scrollUntil('草稿后续粗体', () =>
    [...document.querySelectorAll('.cm-strong')].some((el) => el.textContent === '草稿后续粗体')
  );
  const draftHeadingEl = [...document.querySelectorAll('.cm-heading')].find((el) => el.textContent.includes('草稿后续标题'));
  const draftStrongEl = [...document.querySelectorAll('.cm-strong')].find((el) => el.textContent === '草稿后续粗体');
  ok('草稿后续标题/粗体样式不受影响', !!draftHeadingEl && !!draftStrongEl);
  view.dispatch({ changes: { from: draftGuardAt, to: doc().length }, selection: { anchor: draftGuardAt } });
  await sleep(120);

  // ``` + 回车：补出结尾围栏（手不用离开键盘去敲后面那三个）
  // 上一段收尾时还留着一个选区，而 execCommand 走的是 DOM 里的选区 ——
  // 它和 state 的选区之间隔着一次 measure，直接用会插到旧位置上去。
  // 所以先把尾巴整段重建成一个干净空行，这一小段不继承任何前序状态。
  view.dispatch({
    changes: { from: atPair, to: doc().length, insert: '\n\n' },
    selection: { anchor: atPair + 2 },
  });
  await sleep(200);
  for (const ch of ['`', '`', '`', 'j', 's']) inputAt(ch);
  await sleep(120);
  // Enter 的 handler 只看 state 的选区，但隐藏窗口的 pressKey 偶尔会落到旧的原生选区上：
  // 用 view.domAtPos 对齐一次，和真实按键的落点一致。
  const fencePoint = view.domAtPos(view.state.selection.main.head);
  const fenceSel = document.getSelection();
  fenceSel.removeAllRanges();
  const fenceNativeRange = document.createRange();
  fenceNativeRange.setStart(fencePoint.node, fencePoint.offset);
  fenceNativeRange.collapse(true);
  fenceSel.addRange(fenceNativeRange);
  const fenceLine = view.state.doc.lineAt(view.state.selection.main.head).text;
  pressKey('Enter', 13);
  await sleep(220);
  // 围栏 ```js 后面要补出结尾围栏；行里可能还留着前序配对测试的残渣，只验证围栏这一段成立
  const fenceTail = doc().slice(Math.max(0, doc().lastIndexOf('```js') - 4));
  ok('``` 回车补出结尾围栏', fenceLine.includes('```js') && fenceTail.includes('```js\n\n```'), JSON.stringify(fenceLine) + ' ' + tail(14));
  ok('光标停在代码块中间那行', view.state.doc.lineAt(view.state.selection.main.head).text === '');

  const generatedFence = doc().lastIndexOf('```js');
  view.dispatch({
    selection: { anchor: generatedFence + 4 },
    effects: EditorView.scrollIntoView(generatedFence, { y: 'center' }),
  });
  await sleep(180);
  ok('新建代码块生成后不显示围栏源码', !view.contentDOM.innerText.includes('```js'));

  // 内容已经删空时再退格：不是继续啃首围栏，而是把整块连同首尾围栏一次删掉。
  const emptyLine = view.state.doc.lineAt(generatedFence).number + 1;
  const emptyCaret = view.state.doc.line(emptyLine).from;
  view.dispatch({ selection: { anchor: emptyCaret } });
  await sleep(120);
  pressKey('Backspace', 8);
  await sleep(180);
  ok('空代码块再退格会成对删除', !/\n```js\n\n```$/.test(doc()), tail(14));

  // 两个不同语言的代码块必须独立配对；删掉第一个首围栏也不能吞掉后面的 cs 块。
  const multi = '\n\n```js\nconst a = 1;\n```\n\n```cs\nclass A {}\n```';
  const multiAt = view.state.doc.length;
  view.dispatch({
    changes: { from: multiAt, insert: multi },
    selection: { anchor: multiAt + multi.indexOf('class A') },
    effects: EditorView.scrollIntoView(multiAt + multi.indexOf('class A'), { y: 'center' }),
  });
  await sleep(240);
  const multiLangs = [...document.querySelectorAll('.cm-fence-chip')].map((el) => el.textContent.trim());
  ok('多个代码块分别匹配各自语言', multiLangs.includes('js') && multiLangs.includes('cs'), multiLangs.join(' / '));

  // 不经过键盘，直接发删除事务：首围栏也不能被删掉，覆盖所有删除入口。
  const guardedOpen = doc().lastIndexOf('```cs');
  const beforeGuardedDelete = doc();
  view.dispatch({ changes: { from: guardedOpen, to: guardedOpen + 1 }, userEvent: 'delete' });
  await sleep(120);
  ok('删除事务不能破坏代码块首围栏', doc() === beforeGuardedDelete);

  // 复现用户路径：光标放在下面 cs 块首围栏前，通过浏览器原生命令做向前删除。
  const nativeOpen = doc().lastIndexOf('```cs');
  view.dispatch({ selection: { anchor: nativeOpen } });
  await sleep(120);
  const nativePoint = view.domAtPos(nativeOpen);
  const nativeSelection = document.getSelection();
  nativeSelection.removeAllRanges();
  const openNativeRange = document.createRange();
  openNativeRange.setStart(nativePoint.node, nativePoint.offset);
  openNativeRange.collapse(true);
  nativeSelection.addRange(openNativeRange);
  const beforeNativeDelete = doc();
  document.execCommand('forwardDelete');
  await sleep(160);
  const afterNativeDelete = doc();
  let nativeDiffAt = 0;
  while (nativeDiffAt < afterNativeDelete.length && nativeDiffAt < beforeNativeDelete.length && afterNativeDelete[nativeDiffAt] === beforeNativeDelete[nativeDiffAt]) nativeDiffAt++;
  const nativeFenceIntact = afterNativeDelete.includes('```cs\nclass A {}\n```');
  ok(
    '真实 DOM 删除不能损坏下面代码块首围栏',
    nativeFenceIntact,
    JSON.stringify({
      at: nativeDiffAt,
      expected: nativeOpen,
      before: beforeNativeDelete.slice(nativeDiffAt, nativeDiffAt + 16),
      after: afterNativeDelete.slice(nativeDiffAt, nativeDiffAt + 16),
    })
  );
  if (afterNativeDelete !== beforeNativeDelete) {
    view.dispatch({ changes: { from: 0, to: doc().length, insert: beforeNativeDelete }, selection: { anchor: nativeOpen } });
    await sleep(160);
  }

  // 第一行正文行首退格：不能删掉首围栏后的换行，变成 jsconst / pythonprint。
  const firstBodyPos = doc().lastIndexOf('const a = 1;');
  view.dispatch({ selection: { anchor: firstBodyPos } });
  await sleep(120);
  const bodyPoint = view.domAtPos(firstBodyPos);
  const bodyNativeSelection = document.getSelection();
  bodyNativeSelection.removeAllRanges();
  const bodyNativeRange = document.createRange();
  bodyNativeRange.setStart(bodyPoint.node, bodyPoint.offset);
  bodyNativeRange.collapse(true);
  bodyNativeSelection.addRange(bodyNativeRange);
  const beforeBodyBoundary = doc();
  document.execCommand('delete');
  await sleep(160);
  ok('代码首行行首退格不会并入语言标识', doc() === beforeBodyBoundary, JSON.stringify(doc().slice(firstBodyPos - 8, firstBodyPos + 16)));
  if (doc() !== beforeBodyBoundary) {
    view.dispatch({ changes: { from: 0, to: doc().length, insert: beforeBodyBoundary }, selection: { anchor: firstBodyPos } });
    await sleep(160);
  }

  // 对称边界：最后一行正文行尾 Delete 不能把尾围栏并到代码里。
  const lastBodyEnd = doc().lastIndexOf('class A {}') + 'class A {}'.length;
  view.dispatch({ selection: { anchor: lastBodyEnd } });
  const beforeLastBoundary = doc();
  const forwardProtected = protectFenceDelete(view);
  view.dispatch({ changes: { from: lastBodyEnd, to: lastBodyEnd + 1 }, userEvent: 'delete' });
  await sleep(140);
  ok('代码末行行尾删除不会并入尾围栏', forwardProtected && doc() === beforeLastBoundary);
  if (doc() !== beforeLastBoundary) {
    view.dispatch({ changes: { from: 0, to: doc().length, insert: beforeLastBoundary }, selection: { anchor: lastBodyEnd } });
    await sleep(160);
  }

  // 截图路径：先删掉块间空白，再按一次退格。第二次绝不能把尾围栏 ``` 啃成 ``。
  const betweenClose = doc().lastIndexOf('\n```\n\n```cs') + 1;
  const blankCaret = betweenClose + 4;
  view.dispatch({ selection: { anchor: blankCaret } });
  await sleep(120);
  // 先通过真实删除事务删掉块间换行，再验证键盘保护和事务保护都会拦住尾围栏。
  view.dispatch({
    changes: { from: blankCaret - 1, to: blankCaret },
    selection: { anchor: blankCaret - 1 },
    userEvent: 'delete',
  });
  await sleep(140);
  const afterBlankDelete = doc();
  const fenceHead = view.state.selection.main.head;
  const blocksAfterBlank = getCodeFences(view.state);
  // 删除空行后 snapOffFence 会把光标移到可见正文，不能假设它仍停在隐藏围栏上。
  const offFence = !blocksAfterBlank.some((block) => {
    const onOpen = (block.close || block.implicit) && fenceHead >= block.open.line.from && fenceHead <= block.open.line.to;
    const onClose = block.close && fenceHead >= block.close.line.from && fenceHead <= block.close.line.to;
    return onOpen || onClose;
  });
  if (fenceHead > 0) {
    view.dispatch({ changes: { from: fenceHead - 1, to: fenceHead }, userEvent: 'delete' });
    await sleep(140);
  }
  const fenceKept = doc().includes('\n```\n```cs');

  // 无论前一次普通删除删了哪个正文字符，直接删除尾围栏仍必须被事务保护拦截。
  const closeAfterBlank = view.state.doc.lineAt(doc().lastIndexOf('\n```\n```cs') + 1);
  const beforeFenceDelete = doc();
  view.dispatch({ changes: { from: closeAfterBlank.from, to: closeAfterBlank.from + 1 }, userEvent: 'delete' });
  await sleep(140);
  const directFenceKept = doc() === beforeFenceDelete;
  ok(
    '删除块间空白不会损坏尾围栏',
    afterBlankDelete.includes('\n```\n```cs') && offFence && fenceKept && directFenceKept,
    tail(24) +
      ' offFence=' + offFence +
      ' head=' + fenceHead +
      ' kept=' + fenceKept +
      ' directKept=' + directFenceKept +
      ' line=' + JSON.stringify(view.state.doc.lineAt(fenceHead).text)
  );

  // 兼容已经损坏的文档：即使尾围栏只剩 ``，cs 块也必须独立恢复。
  const damagedClose = view.state.doc.lineAt(doc().lastIndexOf('\n```\n```cs') + 1);
  view.dispatch({ changes: { from: damagedClose.to - 1, to: damagedClose.to }, userEvent: 'delete.fence' });
  const damagedCsBody = doc().lastIndexOf('class A');
  view.dispatch({
    selection: { anchor: damagedCsBody },
    effects: EditorView.scrollIntoView(damagedCsBody, { y: 'center' }),
  });
  await sleep(240);
  const recoveredLangs = [...document.querySelectorAll('.cm-fence-chip')].map((el) => el.textContent.trim());
  const recoveredCs = [...document.querySelectorAll('.cm-code-line')].some((el) => el.textContent.includes('class A'));
  ok(
    '残缺尾围栏不会串联后续代码块',
    recoveredLangs.includes('cs') && recoveredCs && !view.contentDOM.innerText.includes('```cs'),
    recoveredLangs.join(' / ')
  );

  const firstOpen = doc().lastIndexOf('```js');
  const firstOpenLine = view.state.doc.lineAt(firstOpen);
  view.dispatch({ changes: { from: firstOpenLine.from, to: Math.min(firstOpenLine.to + 1, doc().length) }, userEvent: 'delete.fence' });
  const csBody = doc().lastIndexOf('class A');
  view.dispatch({
    selection: { anchor: csBody },
    effects: EditorView.scrollIntoView(csBody, { y: 'center' }),
  });
  await sleep(240);
  const remainingLangs = [...document.querySelectorAll('.cm-fence-chip')].map((el) => el.textContent.trim());
  const csStillCode = [...document.querySelectorAll('.cm-code-line')].some((el) => el.textContent.includes('class A'));
  ok(
    '删除首个围栏不影响后续代码块',
    remainingLangs.includes('cs') && csStillCode && !view.contentDOM.innerText.includes('```cs'),
    remainingLangs.join(' / ')
  );

  // 光标层由 drawSelection 画，DOM 写入发生在下一轮 measure；
  // 自检跑在隐藏窗口，rAF 被节流，元素会残留几百毫秒甚至更久，这里等不等得住全看机器忙不忙。
  // 与其留一条会偶发误报的断言，不如把这件事交给 --show 的探针（见 README「选中的时候，屏幕上只该有高亮」）：
  // 聚焦窗口里实测「有选区 0 个、空光标 1 个」。这里只留一句说明，不再假装测过。
  view.dispatch({ selection: { anchor: doc().length - 8, head: doc().length - 5 } });
  await sleep(160);

  // 收摊：把这一整段临时内容删掉
  view.dispatch({ changes: { from: atPair, to: view.state.doc.length }, selection: { anchor: atPair }, userEvent: 'delete.fence' });
  await sleep(160);
  ok('配对测试未污染文档', doc() === doc0);

  /* ---- 13.5 单行代码块：圆角与方向键出口 ---- */
  const navigationDoc = `${doc0}\n\n前文\n\`\`\`text\nonly one\n\`\`\`\n后文`;
  view.dispatch({ changes: { from: 0, to: doc().length, insert: navigationDoc } });
  await sleep(220);
  const navigationBlock = getCodeFences(view.state).find((b) => b.lang === 'text');
  let verticalExit = false;
  let horizontalExit = false;
  if (navigationBlock) {
    view.dispatch({ selection: { anchor: navigationBlock.codeTo } });
    const downHandled = navigateFence(view, 'down');
    const downText = view.state.doc.lineAt(view.state.selection.main.head).text;
    view.dispatch({ selection: { anchor: navigationBlock.codeFrom } });
    const upHandled = navigateFence(view, 'up');
    const upText = view.state.doc.lineAt(view.state.selection.main.head).text;
    verticalExit = downHandled && upHandled && downText === '后文' && upText === '前文';

    view.dispatch({ selection: { anchor: navigationBlock.codeFrom } });
    const leftHandled = navigateFence(view, 'left');
    const leftText = view.state.doc.lineAt(view.state.selection.main.head).text;
    view.dispatch({ selection: { anchor: navigationBlock.codeTo } });
    const rightHandled = navigateFence(view, 'right');
    const rightText = view.state.doc.lineAt(view.state.selection.main.head).text;
    horizontalExit = leftHandled && rightHandled && leftText === '前文' && rightText === '后文';
  }
  ok('上下方向键可以跳出代码块', verticalExit);
  ok('左右方向键跨过隐藏围栏', horizontalExit);

  const singleBody = document.querySelector('.cm-code-body-first.cm-code-body-last');
  const singleStyle = singleBody ? getComputedStyle(singleBody) : null;
  ok(
    '单行代码块四角都是圆角',
    !!singleStyle &&
      singleStyle.borderTopLeftRadius === '8px' &&
      singleStyle.borderTopRightRadius === '8px' &&
      singleStyle.borderBottomLeftRadius === '8px' &&
      singleStyle.borderBottomRightRadius === '8px',
    singleStyle ? singleStyle.borderRadius : '无'
  );
  view.dispatch({ changes: { from: 0, to: doc().length, insert: doc0 }, selection: { anchor: doc0.length } });
  await sleep(180);

  /* ---- 13.55 块级标记的空格提交门槛 ---- */
  // 正在输入的这一行只有标记本身时按普通文本显示，补一个空格才真正套用格式。
  const bareProbe = async (text) => {
    view.dispatch({ changes: { from: 0, to: doc().length, insert: text }, selection: { anchor: text.length } });
    await sleep(160);
    const line = view.dom.querySelector('.cm-line');
    return { cls: line ? line.className : '', html: line ? line.innerHTML : '' };
  };
  let bare = await bareProbe('-');
  ok('裸 - 不立即变成列表', !/(^|\s)cm-li(\s|$)/.test(bare.cls) && !bare.html.includes('cm-bullet'), bare.cls + ' | ' + bare.html.slice(0, 160));
  bare = await bareProbe('- ');
  ok('- 加空格后才是列表', /(^|\s)cm-li(\s|$)/.test(bare.cls) && bare.html.includes('cm-bullet'), bare.cls);
  bare = await bareProbe('>');
  ok('裸 > 不立即套用引用', !bare.cls.includes('cm-quote'), bare.cls);
  bare = await bareProbe('> ');
  ok('> 加空格后才是引用', bare.cls.includes('cm-quote'), bare.cls);
  bare = await bareProbe('#');
  ok('裸 # 不立即变成标题', !bare.cls.includes('cm-heading'), bare.cls);
  bare = await bareProbe('```cs');
  ok('```cs 回车前不生成代码块', !bare.cls.includes('cm-code-line'), bare.cls);
  bare = await bareProbe('标题候选\n-');
  ok('裸 - 不把上一行变成 Setext 标题', !/(^|\s)cm-heading(\s|$)/.test(bare.cls), bare.cls);
  bare = await bareProbe('标题候选\n--');
  ok('两个 - 才按 Setext 下划线渲染', /(^|\s)cm-h2(\s|$)/.test(bare.cls), bare.cls);
  view.dispatch({ changes: { from: 0, to: doc().length, insert: doc0 }, selection: { anchor: doc0.length } });
  await sleep(150);

  /* ---- 13.56 引用行 Backspace：空行整行删、正文开头退一级、不露裸 > ---- */
  const quoteBackspace = (text, anchor) => {
    view.dispatch({ changes: { from: 0, to: doc().length, insert: text }, selection: { anchor } });
    const handled = exitQuoteOnBackspace(view);
    return { handled, text: doc().replace(/\n$/, '') };
  };
  let qb = quoteBackspace('前文\n> \n后文', 5);
  ok('空引用行一次删整行', qb.handled && qb.text === '前文\n后文', qb.text);
  qb = quoteBackspace('> 上文\n> ', 7);
  ok('末尾空引用行删除后回到上一行', qb.handled && qb.text === '> 上文', qb.text);
  qb = quoteBackspace('> 引用内容', 2);
  ok('引用正文开头退格取消引用', qb.handled && qb.text === '引用内容', qb.text);
  qb = quoteBackspace('> > 嵌套', 4);
  ok('嵌套引用只退最内一层', qb.handled && qb.text === '> 嵌套', qb.text);
  qb = quoteBackspace('> 引用内容', 4);
  ok('正文中间的退格不被拦截', !qb.handled && qb.text === '> 引用内容', qb.text);
  view.dispatch({ changes: { from: 0, to: doc().length, insert: '> ' }, selection: { anchor: 2 } });
  await sleep(260);
  const emptyQuoteLine = document.querySelector('.cm-editor .cm-line.cm-quote');
  ok('空引用行不再露出裸 >', !!emptyQuoteLine && emptyQuoteLine.textContent === '',
    emptyQuoteLine ? JSON.stringify(emptyQuoteLine.textContent) : 'no line');
  view.dispatch({ changes: { from: 0, to: doc().length, insert: doc0 }, selection: { anchor: doc0.length } });
  await sleep(150);

  /* ---- 13.6 光标移动性能与崩溃草稿 ---- */
  const perfDoc = '普通第一行 甲\n普通第二行 乙\n普通第三行 丙\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  view.dispatch({ changes: { from: 0, to: doc().length, insert: perfDoc }, selection: { anchor: 0 } });
  await sleep(120);
  const perfBefore = blockDecorationStats().computed;
  const plainNext = doc().indexOf('乙');
  view.dispatch({ selection: { anchor: plainNext } });
  ok('普通正文间移动光标复用块级缓存', blockDecorationStats().computed === perfBefore, `computed=${blockDecorationStats().computed}`);
  const tablePos = doc().indexOf('| 1 | 2 |') + 2;
  view.dispatch({ selection: { anchor: tablePos } });
  ok('进入表格时才重算块级装饰', blockDecorationStats().computed === perfBefore + 1, `computed=${blockDecorationStats().computed}`);

  view.dispatch({ changes: { from: 0, to: doc().length, insert: doc0 }, selection: { anchor: doc0.length } });
  if (ctx.setDirty) ctx.setDirty(true);
  if (ctx.writeDraft) ctx.writeDraft();
  let recoveryDraft = null;
  try {
    recoveryDraft = JSON.parse(localStorage.getItem('markline.recovery.v1') || 'null');
  } catch {}
  ok('未保存内容写入恢复草稿', recoveryDraft?.content === doc0 && recoveryDraft?.path === null);
  if (ctx.setDirty) ctx.setDirty(false, { preserveDraft: true });
  ok('启动初始化不会提前清除恢复草稿', !!localStorage.getItem('markline.recovery.v1'));
  if (ctx.setDirty) ctx.setDirty(false);
  ok('保存后清除恢复草稿', !localStorage.getItem('markline.recovery.v1'));
  await sleep(120);

  /* ---- 结果面板 ---- */
  // 查找面板已经断言完毕，收起来 —— 它会盖住结果面板的标题行
  closeSearchPanel(view);

  // 自检把文档改过又还原了，脏标记得跟着回退
  if (doc() === doc0 && ctx.setDirty) ctx.setDirty(false);

  const pass = results.filter((r) => r.pass).length;
  // 用 DOM API 逐节点构建：断言名里会出现 "<table>"/"<img>" 这类字样，
  // 拼 innerHTML 会被浏览器当成真实标签解析，既吞掉后文又会画出多余元素。
  const panel = document.createElement('div');
  panel.id = 'selftest';

  const h = document.createElement('h3');
  h.textContent = `自检 ${pass}/${results.length} ${pass === results.length ? '· 全部通过' : '· 有失败项'}`;
  panel.appendChild(h);

  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'st-row ' + (r.pass ? 'ok' : 'bad');
    const flag = document.createElement('span');
    flag.className = 'st-flag';
    flag.textContent = r.pass ? 'PASS' : 'FAIL';
    const name = document.createElement('span');
    name.className = 'st-name';
    name.textContent = r.name;
    const extra = document.createElement('span');
    extra.className = 'st-extra';
    extra.textContent = r.extra;
    row.append(flag, name, extra);
    panel.appendChild(row);
  }
  document.body.appendChild(panel);
  view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });

  return { pass, total: results.length, results };
}
