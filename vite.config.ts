import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
/// <reference types="vitest" />

const host = process.env.TAURI_DEV_HOST;

// Dev backend port. Deliberately NOT 3001 (the standalone/share default) so a
// dev session never collides with — or silently proxies into — an installed
// Alloy app holding :3001. Keep in sync with scripts/dev-server.sh.
const devServerPort = process.env.ALLOY_DEV_PORT || '3030';

// All builds (web + Tauri) now route Tauri plugin imports to the HTTP shims
// under src/services/api/. The shims for native-OS plugins (dialog, opener,
// updater, process, menu) detect the Tauri runtime and forward to the real
// plugin via direct `invoke`; in a pure browser they degrade to a best-
// effort fallback (window.open, etc.).
export default defineConfig(async () => ({
  plugins: [react()],
  build: { outDir: 'dist-web' },
  resolve: {
    alias: {
      '@tauri-apps/plugin-fs': path.resolve(__dirname, 'src/services/api/tauri-fs-http.ts'),
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'src/services/api/tauri-dialog.ts'),
      '@tauri-apps/plugin-opener': path.resolve(__dirname, 'src/services/api/tauri-opener.ts'),
      '@tauri-apps/plugin-updater': path.resolve(__dirname, 'src/services/api/tauri-updater.ts'),
      '@tauri-apps/plugin-process': path.resolve(__dirname, 'src/services/api/tauri-process.ts'),
      '@tauri-apps/api/path': path.resolve(__dirname, 'src/services/api/tauri-path.ts'),
      '@tauri-apps/api/menu': path.resolve(__dirname, 'src/services/api/tauri-menu.ts'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || '0.0.0.0',
    allowedHosts: ['.ts.net'],
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    // In web-mode dev (`npm run dev`, which runs Vite + the standalone
    // alloy-serve), proxy /api so the SPA can use same-origin paths. Targets
    // the dedicated dev port, not 3001, so it never reaches an installed app.
    proxy: {
      '/api': {
        target: `http://localhost:${devServerPort}`,
        ws: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: './src/test/setup.ts',
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
  },
}));
