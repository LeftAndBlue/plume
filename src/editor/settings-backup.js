/**
 * 设置备份：把偏好类 localStorage 键导出为 JSON，或从备份导入。
 * 从 runtime.js 抽离；依赖通过工厂注入。不含文档草稿与会话状态。
 */
import { APPEARANCE_KEY, LOCALE_KEY, SETTINGS_KEYS } from "./storage-keys.js";
import { setLocale } from "../i18n.js";

export function createSettingsBackup({ flash, browserDownload, openSettings, updateAppearance }) {
  async function exportSettings() {
    const settings = {};
    for (const key of SETTINGS_KEYS) {
      const v = localStorage.getItem(key);
      if (v != null) settings[key] = v;
    }
    const json = JSON.stringify(
      { app: "plume", kind: "settings", version: 1, exportedAt: new Date().toISOString(), settings },
      null,
      2,
    );
    const name = "plume-settings.json";
    if (window.studio) {
      try {
        const p = await window.studio.exportFile({
          bytes: new TextEncoder().encode(json),
          s: name,
          kind: "Plume 设置",
          ext: "json",
        });
        if (p) flash("已导出设置 " + p.split(/[\\/]/).pop());
      } catch (err) {
        if (String(err && err.message ? err.message : err).includes("已取消")) return;
        throw err;
      }
    } else {
      browserDownload(name, json, "application/json");
    }
  }

  async function importSettings() {
    let text = null;
    if (window.studio) {
      text = await window.studio.pickSettingsFile();
    } else {
      text = await new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => resolve(input.files[0] ? input.files[0].text() : null);
        input.click();
      });
    }
    if (!text) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("文件不是有效的 JSON");
    }
    if (
      !data || data.app !== "plume" || data.kind !== "settings" ||
      data.version !== 1 || !data.settings || typeof data.settings !== "object"
    ) {
      throw new Error("不是 Plume 设置备份文件，或版本不受支持");
    }
    let count = 0;
    for (const key of SETTINGS_KEYS) {
      const v = data.settings[key];
      if (typeof v !== "string") continue;
      try {
        localStorage.setItem(key, v);
        count++;
      } catch {
        /* 存储不可用时跳过这一项 */
      }
    }
    if (!count) throw new Error("文件里没有可识别的设置项");
    // 语言立即生效（setLocale 会校验合法值并通知界面刷新）
    const locale = data.settings[LOCALE_KEY];
    if (locale) setLocale(locale);
    // 外观立即生效；侧栏布局等键在下次启动时读取
    const appearance = data.settings[APPEARANCE_KEY];
    if (appearance) {
      try {
        updateAppearance(JSON.parse(appearance));
      } catch {
        /* 外观数据损坏时保持当前外观 */
      }
    }
    flash("设置已导入，布局类项重启后生效");
    openSettings(); // 刷新面板里的当前值
  }

  return { exportSettings, importSettings };
}