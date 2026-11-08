import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true }, "/auth": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
});
