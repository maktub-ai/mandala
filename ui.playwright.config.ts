import { defineConfig } from '@playwright/test';
const port = Number(process.env.MANDALA_UI_PORT ?? 4329);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({testDir:'./tests/ui',outputDir:'./test-results-ui',workers:1,use:{baseURL,viewport:{width:1280,height:850}},webServer:{command:`node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,url:`${baseURL}/ui.html`,reuseExistingServer:false}});
