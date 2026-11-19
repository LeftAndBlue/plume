// 应用内更新：检查 GitHub Releases 的 latest.json → 提示 → 下载安装 → 重启。
// 签名校验由 updater 插件用 tauri.conf.json 里的公钥完成，这里只管交互。
// 只在 Tauri 壳里生效；浏览器开发/自检环境直接短路。
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri } from "./studio.js";
import { t } from "../i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

export function createUpdater({ openSheet, flash, settle }) {
  let busy = false;

  async function checkForUpdate({ silent = false } = {}) {
    if (!isTauri || busy) return;
    busy = true;
    try {
      const update = await check({ timeout: 15000 });
      if (!update) {
        if (!silent) flash(t("update.latest"));
        return;
      }
      promptInstall(update);
    } catch (err) {
      // 静默检查失败不打扰用户（离线、仓库还没发版都会走到这里）
      if (!silent) flash(t("update.failed") + (err?.message || String(err)));
    } finally {
      busy = false;
    }
  }

  function promptInstall(update) {
    openSheet(t("update.title"), (body, close) => {
      body.innerHTML = `
        <div class="settings-group">
          <h3>${esc(t("update.available", { v: update.version }))}</h3>
          <p class="settings-note">${esc(t("update.current", { v: update.currentVersion }))}</p>
          ${update.body ? `<pre class="license-copy">${esc(update.body)}</pre>` : ""}
          <p class="settings-note" id="update-status" hidden></p>
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
        const say = (msg) => { status.hidden = false; status.textContent = msg; };
        try {
          // 安装会退出应用：先把当前文档落盘（弹保存询问），用户取消则中止
          if (settle && !(await settle())) {
            installBtn.disabled = false;
            laterBtn.disabled = false;
            return;
          }
          let total = 0;
          let got = 0;
          say(t("update.downloading", { p: 0 }));
          await update.downloadAndInstall((ev) => {
            if (ev.event === "Started") {
              total = ev.data.contentLength ?? 0;
            } else if (ev.event === "Progress") {
              got += ev.data.chunkLength;
              say(t("update.downloading", { p: total ? Math.min(99, Math.round((got / total) * 100)) : 0 }));
            } else if (ev.event === "Finished") {
              say(t("update.installing"));
            }
          });
          // Windows 上安装前应用已退出；走到这里说明平台允许装完再重启
          say(t("update.done"));
          await relaunch();
        } catch (err) {
          say(t("update.failed") + (err?.message || String(err)));
          installBtn.disabled = false;
          laterBtn.disabled = false;
        }
      });
    });
  }

  return { checkForUpdate };
}