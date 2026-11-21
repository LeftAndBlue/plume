/**
 * 导出命令：HTML / 无样式 HTML / Word / RTF / LaTeX / EPUB / PNG / PDF。
 * 从 runtime.js 抽离；依赖通过工厂注入，行为与抽离前一致。
 */
import { exportHtmlReady } from "./markdown-export.js";
import { markdownToDocx } from "./docx-export.js";
import { markdownToEpub, markdownToLatex, markdownToRtf } from "./text-export.js";
import { currentThemeId, getAppearance } from "./theme.js";

export function createExportCommands({ state, view, flash, browserDownload }) {
  const docText = () => view.state.doc.toString();

  /**
   * 导出的配色与版式取自当前设置：
   * HTML / 长图按屏幕尺寸与主题（深色主题保留原色），PDF 走 print 模式
   * （深色主题会自动退回浅色配色，纸上才可读）。
   */
  function exportOptions(mode, extra = {}) {
    return {
      theme: currentThemeId(),
      template: getAppearance().exportTemplate || "doc",
      mode,
      ...extra,
    };
  }

  function exportBaseName() {
    return state.path
      ? state.path.split(/[\\/]/).pop().replace(/\.md$/i, "")
      : "未命名";
  }

  async function saveExport(name, payload, mime) {
    if (window.studio?.exportFile) {
      // Rust 侧 ExportFilePayload 的字段是 s/kind/ext/bytes：
      // 文本类导出（RTF/LaTeX）统一编码成字节走 raw 写入，不做 HTML 物化。
      const bytes = payload.bytes || new TextEncoder().encode(payload.text || "");
      const p = await window.studio.exportFile({
        bytes,
        s: name,
        kind: payload.filterName || "文件",
        ext: (payload.extensions && payload.extensions[0]) || undefined,
      });
      if (p) flash("已导出 " + p.split(/[\\/]/).pop());
      return;
    }
    browserDownload(name, payload.bytes || payload.text || "", mime);
  }

  async function doExportHtml() {
    const name = exportBaseName() + ".html";
    const html = await exportHtmlReady(docText(), exportOptions("screen", { title: name }));
    if (window.studio) {
      const p = await window.studio.exportHtml(html, name, state.dir);
      if (p) flash("已导出 " + p.split(/[\\/]/).pop());
    } else {
      browserDownload(name, html, "text/html");
    }
  }

  async function doExportHtmlBare() {
    const name = exportBaseName() + ".html";
    const html = await exportHtmlReady(docText(), { title: name, bare: true });
    if (window.studio) {
      const p = await window.studio.exportHtml(html, name, state.dir);
      if (p) flash("已导出 " + p.split(/[\\/]/).pop());
    } else browserDownload(name, html, "text/html");
  }

  async function doExportDocx() {
    const name = exportBaseName() + ".docx";
    const bytes = markdownToDocx(docText());
    if (window.studio?.exportDocx) {
      const p = await window.studio.exportDocx(bytes, name);
      if (p) flash("已导出 " + p.split(/[\\/]/).pop());
    } else {
      browserDownload(name, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }
  }

  async function doExportRtf() {
    const name = exportBaseName() + ".rtf";
    await saveExport(
      name,
      { text: markdownToRtf(docText()), filterName: "RTF", extensions: ["rtf"] },
      "application/rtf",
    );
  }

  async function doExportLatex() {
    const name = exportBaseName() + ".tex";
    await saveExport(
      name,
      { text: markdownToLatex(docText()), filterName: "LaTeX", extensions: ["tex"] },
      "application/x-tex",
    );
  }

  async function doExportEpub() {
    const name = exportBaseName() + ".epub";
    const bytes = markdownToEpub(docText(), exportBaseName());
    await saveExport(
      name,
      { bytes, filterName: "EPUB", extensions: ["epub"] },
      "application/epub+zip",
    );
  }

  async function doExportPng() {
    if (!window.studio?.exportPng) {
      flash("导出图片需要桌面版");
      return;
    }
    const name = exportBaseName() + ".png";
    const html = await exportHtmlReady(
      docText(),
      exportOptions("screen", { title: name, readyScript: true }),
    );
    try {
      const p = await window.studio.exportPng(html, name, state.dir);
      if (p) flash("已导出 " + p.split(/[\\/]/).pop());
    } catch (err) {
      flash("导出图片失败：" + (err && err.message ? err.message : err));
    }
  }

  async function doExportPdf() {
    if (!window.studio) {
      flash("PDF 导出需要桌面版");
      return;
    }
    const name = exportBaseName() + ".pdf";
    const html = await exportHtmlReady(
      docText(),
      exportOptions("print", { title: name, readyScript: true }),
    );
    const p = await window.studio.exportPdf(html, name, state.dir);
    if (p) flash("已导出 " + p.split(/[\\/]/).pop());
  }

  return {
    exportBaseName,
    doExportHtml,
    doExportHtmlBare,
    doExportDocx,
    doExportRtf,
    doExportLatex,
    doExportEpub,
    doExportPng,
    doExportPdf,
  };
}