// 应用内更新：检查 GitHub Releases 的 latest.json → 提示 → 下载安装 → 重启。
// 签名校验由 updater 插件用 tauri.conf.json 里的公钥完成，这里只管交互。
// 只在 Tauri 壳里生效；浏览器开发/自检环境直接短路。
//
// 网络：updater 的 reqwest 不认 Windows 系统代理，国内直连 GitHub 常失败，
// 所以先经 system_proxy 命令读系统代理，显式传给 check（下载沿用同一代理）。
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./studio.js";
import { t } from "../i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

export function createUpdater({ openSheet, settle }) {
  let busy = false;

  async function systemProxy() {
    try {
      return (await invoke("system_proxy")) || undefined;
    } catch {
      return undefined;
    }
  }

  async function checkForUpdate({ silent = false } = {}) {
    if (!isTauri || busy) return;
    busy = true;
    // 手动检查：先弹带旋转等待的面板，结果（最新/失败/有新版本）都落在同一弹框里
    if (!silent) {
      openSheet(t("update.title"), (body, close) => {
        body.innerHTML = `
          <div class="settings-group">
            <p class="update-wait"><span class="update-spinner" aria-hidden="true"></span>${esc(t("update.checking"))}</p>
          </div>`;
      });
    }
    try {
      const proxy = await systemProxy();
      const update = await check({ timeout: 20000, ...(proxy ? { proxy } : {}) });
      if (!update) {
        if (!silent) await showUpToDate();
        return;
      }
      promptInstall(update);
    } catch (err) {
      // 静默检查失败不打扰用户（离线、仓库还没发版都会走到这里）
      if (!silent) showError(err);
    } finally {
      busy = false;
    }
  }

  async function showUpToDate() {
    let info = {};
    try {
      info = (await window.studio?.info?.()) || {};
    } catch {
      /* 版本信息取不到也不影响结论 */
    }
    openSheet(t("update.title"), (body, close) => {
      body.innerHTML = `
        <div class="settings-group">
          <h3>${esc(t("update.latest"))}</h3>
          <p class="settings-note">${esc(t("update.current", { v: info.version || "" }))}</p>
          <div class="settings-actions">
            <button type="button" id="update-close" class="settings-btn">${esc(t("update.close"))}</button>
          </div>
        </div>`;
      body.querySelector("#update-close").addEventListener("click", close);
    });
  }

  function showError(err) {
    openSheet(t("update.title"), (body, close) => {
      body.innerHTML = `
        <div class="settings-group">
          <h3>${esc(t("update.failedTitle"))}</h3>
          <pre class="license-copy">${esc(err?.message || String(err))}</pre>
          <p class="settings-note">${esc(t("update.networkHint"))}</p>
          <div class="settings-actions">
            <button type="button" id="update-retry" class="settings-btn">${esc(t("update.retry"))}</button>
            <button type="button" id="update-close" class="settings-btn">${esc(t("update.close"))}</button>
          </div>
        </div>`;
      body.querySelector("#update-close").addEventListener("click", close);
      body.querySelector("#update-retry").addEventListener("click", () => {
        close();
        checkForUpdate();
      });
    });
  }

  function promptInstall(update) {
    openSheet(t("update.title"), (body, close) => {
      body.innerHTML = `
        <div class="settings-group">
          <h3>${esc(t("update.available", { v: update.version }))}</h3>
          <p class="settings-note">${esc(t("update.current", { v: update.currentVersion }))}</p>
          ${update.body ? `<pre class="license-copy">${esc(update.body)}</pre>` : ""}
          <p class="settings-note update-wait" id="update-status" hidden></p>
          <div class="settings-actions">
            <button type="button" id="update-install" class="settings-btn">${esc(t("update.install"))}</button>
            <button type="button" id="update-later" class="settings-btn">${esc(t("update.later"))}</button>
          </div>
        </div>`;
      const status = body.querySelector("#update-status");
      const installBtn = body.querySelector("#update-install");
      const laterBtn = body.querySelector("#update-later");
      laterBtn.addEventListener("click", close);

      installBtn.addEventListener("click", async () => {
        installBtn.disabled = true;
        laterBtn.disabled = true;
        const say = (msg, spinning) => {
          status.hidden = false;
          status.innerHTML = spinning
            ? `<span class="update-spinner" aria-hidden="true"></span>${esc(msg)}`
            : esc(msg);
        };
        try {
          // 安装会退出应用：先把当前文档落盘（弹保存询问），用户取消则中止
          if (settle && !(await settle())) {
            installBtn.disabled = false;
            laterBtn.disabled = false;
            return;
          }
          let total = 0;
          let got = 0;
          say(t("update.downloading", { p: 0 }), true);
          await update.downloadAndInstall((ev) => {
            if (ev.event === "Started") {
              total = ev.data.contentLength ?? 0;
            } else if (ev.event === "Progress") {
              got += ev.data.chunkLength;
              say(t("update.downloading", { p: total ? Math.min(99, Math.round((got / total) * 100)) : 0 }), true);
            } else if (ev.event === "Finished") {
              say(t("update.installing"), true);
            }
          });
          // Windows 上安装前应用已退出；走到这里说明平台允许装完再重启
          say(t("update.done"), true);
          await relaunch();
        } catch (err) {
          say(t("update.failed") + (err?.message || String(err)), false);
          installBtn.disabled = false;
          laterBtn.disabled = false;
        }
      });
    });
  }

  return { checkForUpdate };
}