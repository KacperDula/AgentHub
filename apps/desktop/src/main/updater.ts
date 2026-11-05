import { app, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import electronUpdater from "electron-updater";

const SIX_HOURS = 6 * 3600_000;

/**
 * electron-updater with the GitHub provider: checks on start and every 6 hours, asks before installing.
 * Unsigned macOS builds cannot auto-install, so there it only offers the download page.
 */
export function setupUpdater(log: (m: string) => void) {
  if (!app.isPackaged) return;
  const releasesUrl = releasesPage();
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} } as any;
  let prompted: string | null = null;

  autoUpdater.on("update-available", async (info) => {
    if (prompted === info.version) return;
    prompted = info.version;
    if (process.platform === "darwin" && !(await isSigned())) {
      const r = await dialog.showMessageBox({
        type: "info",
        message: `AgentTrace ${info.version} is available`,
        detail: "This build is unsigned, so it can't update itself. Download the new version from GitHub.",
        buttons: ["Download", "Later"],
        defaultId: 0,
      });
      if (r.response === 0 && releasesUrl) shell.openExternal(releasesUrl);
      return;
    }
    const r = await dialog.showMessageBox({
      type: "info",
      message: `AgentTrace ${info.version} is available`,
      detail: "Download and install it now? Your data stays where it is.",
      buttons: ["Download", "Later"],
      defaultId: 0,
    });
    if (r.response === 0) autoUpdater.downloadUpdate().catch((e) => log(`update download failed: ${e.message}`));
  });

  autoUpdater.on("update-downloaded", async () => {
    const r = await dialog.showMessageBox({
      type: "info",
      message: "Update ready",
      detail: "Restart AgentTrace to finish installing?",
      buttons: ["Restart", "Later"],
      defaultId: 0,
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });

  const check = () => autoUpdater.checkForUpdates().catch((e) => log(`update check failed: ${e.message}`));
  check();
  setInterval(check, SIX_HOURS);
}

/** True when the running macOS app carries a real (non ad-hoc) code signature. */
async function isSigned(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  const appPath = app.getPath("exe").replace(/\/Contents\/MacOS\/.*$/, "");
  return new Promise((resolve) =>
    execFile("codesign", ["-dv", appPath], (err, _out, stderr) =>
      resolve(!err && /Authority=Developer ID Application/.test(stderr)),
    ),
  );
}

/** The GitHub releases page, from the app-update.yml electron-builder writes at package time. */
function releasesPage(): string | null {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, "app-update.yml"), "utf8");
    const owner = /owner:\s*(\S+)/.exec(yml)?.[1];
    const repo = /repo:\s*(\S+)/.exec(yml)?.[1];
    return owner && repo ? `https://github.com/${owner}/${repo}/releases/latest` : null;
  } catch {
    return null;
  }
}
