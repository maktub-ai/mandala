import { productEnv } from "./cli/product-env.mjs";
import { defineConfig } from "@playwright/test";
import { storedUiState } from './tests/e2e/helpers/preferences';
const baseURL = `http://127.0.0.1:${productEnv("E2E_PORT") ?? 4318}`;
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",
  workers: 1,
  use: {
    locale: "zh-CN",
    storageState: storedUiState(),
    baseURL,
    viewport: { width: 1280, height: 850 },
  },
  webServer: {
    command: "npx tsx tests/e2e/server.ts",
    url: `${baseURL}/api/config`,
    reuseExistingServer: false,
  },
  timeout: 30000,
});
