import { contextBridge, ipcRenderer } from "electron";

// Only the app window gets this bridge. The browser view has no way to change settings or run anything.
const CHANNELS = new Set([
  "settings:get",
  "settings:set",
  "folder:pick",
  "demo:load",
  "demo:clear",
  "data:deleteAll",
  "remote:get",
  "remote:set",
  "remote:revoke",
  "ai:get",
  "ai:set",
  "ai:payload",
  "ai:analyze",
  "ai:vote",
  "ai:explain",
  "ai:learn",
  "insights:run",
  "open:external",
  "notes:get",
  "notes:add",
  "notes:user",
  "notes:inAi",
  "notes:open",
  "notes:pickRoot",
  "notes:resetRoot",
  "notes:remember",
  "coach:get",
  "coach:pick",
  "coach:add",
  "coach:remove",
]);

contextBridge.exposeInMainWorld("agenttrace", {
  invoke(channel: string, ...args: unknown[]) {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
});
