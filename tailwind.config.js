/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  // 编辑器与外壳的视觉仍由 CSS 变量 + 主题文件驱动，Tailwind 只提供布局/间距工具类，
  // 所以关掉 preflight，避免全局 reset 与既有主题级联打架。
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
