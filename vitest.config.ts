import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", include: ["packages/core/test/**/*.test.ts"] } },
      { test: { name: "ui", include: ["packages/ui/test/**/*.test.ts"] } },
      { test: { name: "desktop", include: ["apps/desktop/test/**/*.test.ts"] } },
    ],
    passWithNoTests: true,
  },
});
