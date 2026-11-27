import katexCss from 'katex/dist/katex.min.css?raw';
import { ensureKatex } from './inline-text.js';
import { buildExportCss } from './export-style.js';
import { esc, unesc, inline, renderMarkdown, slugify } from './markdown-render.js';

export { esc, unesc, inline, renderMarkdown, slugify };

/**
 * 导出页里等字体与图片就绪再置位：WebView2 生成 PDF/长图时按这个标记等待，
 * 比「固定等 1.8 秒」可靠——字体没加载完就截，行宽和断行都会偏。
 * 兜底 6 秒，避免字体 API 异常时导出窗口永远等下去。
 */
const READY_SCRIPT = `<script>
(function () {
  var done = function () { window.__plumeExportReady = 1; };
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
  var imgs = [].slice.call(document.images).map(function (img) {
    return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
  });
  Promise.all([fonts].concat(imgs)).then(done, done);
  setTimeout(done, 6000);
})();
</script>`;

export function exportHtml(
  markdown,
  { title = 'Plume', bare = false, theme, template, mode = 'screen', readyScript = false } = {}
) {
  const body = renderMarkdown(markdown);
  if (bare) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
</head><body>
${body}
</body></html>`;
  }
  // 主题配色 + 公共排版层 + 版式模板，见 export-style.js
  const style = buildExportCss({ theme, template, mode });
  // 就绪标记只有 PDF/长图这种「由程序截取」的场景才需要，交到用户手上的 HTML 保持纯净
  return `<!doctype html>
<html lang="zh-CN" data-theme="${style.themeId}" data-export-template="${style.templateId}"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${style.css}\n${katexCss}</style>
</head><body><main>
${body}
</main>${readyScript ? '\n' + READY_SCRIPT : ''}</body></html>`;
}

let exportMermaidPromise = null;
let exportMermaidSeq = 0;

/**
 * 导出前把 Mermaid 固化成 SVG。这样 HTML 不依赖 CDN，PDF/PNG 也不必赌异步绘图何时结束。
 * 测试可以注入 renderMermaid，避免为了解析器断言加载整套图表依赖。
 */
export async function exportHtmlReady(markdown, options = {}) {
  await ensureKatex();
  let html = exportHtml(markdown, options);
  const blocks = [...html.matchAll(/<pre class="mermaid">([\s\S]*?)<\/pre>/g)];
  if (!blocks.length) return html;
  const render =
    options.renderMermaid ||
    (async (code) => {
      if (!exportMermaidPromise) {
        exportMermaidPromise = import('mermaid').then((mod) => {
          const mermaid = mod.default;
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', fontFamily: 'inherit' });
          return mermaid;
        });
      }
      const mermaid = await exportMermaidPromise;
      const { svg } = await mermaid.render('markline-export-' + ++exportMermaidSeq, code);
      return svg;
    });
  for (const block of blocks) {
    try {
      const svg = await render(unesc(block[1]));
      html = html.replace(block[0], `<div class="mermaid-export">${svg}</div>`);
    } catch (err) {
      console.warn('[export:mermaid]', err);
      // 绘图失败时保留原始代码块，不静默丢掉用户的图表源码。
    }
  }
  return html;
}
