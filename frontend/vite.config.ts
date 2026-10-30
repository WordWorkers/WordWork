import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Tauri: keep its CLI output visible and fail instead of picking another port.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
