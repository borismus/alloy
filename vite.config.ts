import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
/// <reference types="vitest" />

const host = process.env.TAURI_DEV_HOST;
const isServerMode = process.env.SERVER_MODE === 'true';

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Build to different directory for server mode
  build: isServerMode ? {
    outDir: 'dist-web',
  } : {},

  // Pass server mode flag to runtime code
  define: isServerMode ? {
    'import.meta.env.VITE_SERVER_MODE': JSON.stringify('true'),
  } : {},

  // In server mode, swap Tauri modules for HTTP-based mocks
  resolve: isServerMode ? {
    alias: {
      '@tauri-apps/plugin-fs': path.resolve(__dirname, 'src/mocks/tauri-fs-http.ts'),
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
