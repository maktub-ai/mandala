import { defineConfig } from "@playwright/test";
export default defineConfig({testDir:"./tests/e2e",testMatch:"*.spec.ts",workers:1,
  use:{locale:"zh-CN",baseURL:"http://127.0.0.1:4331",viewport:{width:1280,height:850}},
  webServer:{command:"MANDALA_E2E_PORT=4331 MANDALA_E2E_SOURCE=1 npx tsx tests/e2e/server.ts",url:"http://127.0.0.1:4331/api/automations",reuseExistingServer:false},timeout:30000});
