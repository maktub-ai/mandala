import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "*.spec.ts", workers: 1, outputDir: "/tmp/mandala-observability-e2e",
  use: { locale: "zh-CN", baseURL: "http://127.0.0.1:4329", viewport: { width: 1280, height: 850 } },
  webServer: { command: "MANDALA_E2E_SOURCE=1 MANDALA_E2E_PORT=4329 npx tsx tests/e2e/server.ts", url: "http://127.0.0.1:4329/api/config", reuseExistingServer: false },
  timeout: 30000,
});
