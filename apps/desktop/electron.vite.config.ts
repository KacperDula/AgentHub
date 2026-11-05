import { defineConfig } from "electron-vite";

// Main and preload only: the UI is packages/ui, served by the app's own local server.
// @agenttrace/core is a devDependency, so it gets bundled into main.
export default defineConfig({
  main: {},
  preload: {},
});
