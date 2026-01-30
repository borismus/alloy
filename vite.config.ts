import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
/// <reference types="vitest" />

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Browser-only mode: explicitly opt-in with BROWSER_ONLY=true
// Use `npm run dev:browser` for mock mode, `cargo tauri dev` for real mode
// @ts-expect-error process is a nodejs global
const isBrowserOnly = process.env.BROWSER_ONLY === 'true';

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // In browser-only mode (BROWSER_ONLY=true), swap Tauri modules for mocks
  resolve: isBrowserOnly ? {
    alias: {
      '@tauri-apps/plugin-fs': path.resolve(__dirname, 'src/mocks/tauri-fs.ts'),
      '@tauri-apps/plugin-dialog': path.resolve(__dirname, 'src/mocks/tauri-dialog.ts'),
      '@tauri-apps/plugin-opener': path.resolve(__dirname, 'src/mocks/tauri-opener.ts'),
      '@tauri-apps/plugin-http': path.resolve(__dirname, 'src/mocks/tauri-http.ts'),
      '@tauri-apps/plugin-updater': path.resolve(__dirname, 'src/mocks/tauri-updater.ts'),
      '@tauri-apps/plugin-process': path.resolve(__dirname, 'src/mocks/tauri-process.ts'),
      '@tauri-apps/api/path': path.resolve(__dirname, 'src/mocks/tauri-path.ts'),
      '@tauri-apps/api/menu': path.resolve(__dirname, 'src/mocks/tauri-menu.ts'),
    },
  } : {},

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: './src/test/setup.ts',
  },
}));
