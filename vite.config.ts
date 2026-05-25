import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
/// <reference types="vitest" />

const host = process.env.TAURI_DEV_HOST;

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
      '@tauri-apps/plugin-http': path.resolve(__dirname, 'src/services/api/tauri-http.ts'),
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
    // In standalone dev (`npm run dev` against alloy-serve on :3001),
    // proxy /api so the SPA can use same-origin paths.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
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
