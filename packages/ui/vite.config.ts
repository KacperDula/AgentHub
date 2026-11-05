import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:ui` serves the UI with hot reload and proxies the API to a running desktop app.
const api = "http://127.0.0.1:8787";
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { "/api": { target: api, changeOrigin: true }, "/login": { target: api, changeOrigin: true } },
  },
});
