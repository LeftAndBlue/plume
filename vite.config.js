import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';

// 导出 HTML 只内嵌 woff2：KaTeX 原始 CSS 里的 woff/ttf 回退引用在 ?raw 文本里剥掉，
// 与 Rust 端 materializeExportedHtml 只替换 fonts/*.woff2 的约定一致。
function stripKaTeXFallbackFonts(css) {
  return css.replace(/,\s*url\((['"]?)[^)'"]+\.(?:woff|ttf)\1\)\s*format\((['"]?)(?:woff|truetype)\2\)/gi, '');
}

const kaTeXRawPlugin = {
  name: 'plume-katex-raw',
  load(id) {
    const file = id.split('?')[0];
    if (!/katex(?:\.min)?\.css$/.test(file)) return null;
    const css = stripKaTeXFallbackFonts(fs.readFileSync(file, 'utf8'));
    // ?raw：导出 HTML 内嵌用，保留 fonts/*.woff2 相对引用（Rust 端按此约定替换成 base64），
    // 返回裸 CSS 文本，由 vite:asset 包装成模块。
    if (id.includes('?raw')) return css;
    if (id.includes('?')) return null;
    // 渲染用：WebView2 只认 woff2 就够了；直接指向 public/fonts 的现成副本，
    // 避免 Vite 再把同一批字体以哈希名产出一遍（ttf/woff/woff2 三格式约 1MB 冗余）。
    return css.replace(/url\((['"]?)fonts\/([^)'"]+\.woff2)\1\)/gi, 'url($1/fonts/$2$1)');
  },
};

export default defineConfig({
  plugins: [vue(), kaTeXRawPlugin],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'chrome120',
    chunkSizeWarningLimit: 1600,
  },
});
