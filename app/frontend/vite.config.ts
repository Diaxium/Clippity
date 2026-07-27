import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri's dev server hits this port (matches tauri.conf.json devUrl).
const TAURI_DEV_PORT = 1420;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@app": fileURLToPath(new URL("./src/app", import.meta.url)),
      "@features": fileURLToPath(new URL("./src/features", import.meta.url)),
      "@windows": fileURLToPath(new URL("./src/windows", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@services": fileURLToPath(new URL("./src/services", import.meta.url)),
      "@state": fileURLToPath(new URL("./src/state", import.meta.url)),
      "@styles": fileURLToPath(new URL("./src/styles", import.meta.url)),
      "@config": fileURLToPath(new URL("./src/config", import.meta.url)),
      "@assets": fileURLToPath(new URL("./src/assets", import.meta.url)),
    },
  },

  // Tauri expects a fixed port and will fail fast if it can't bind it.
  clearScreen: false,
  server: {
    port: TAURI_DEV_PORT,
    strictPort: true,
    host: "localhost",
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: TAURI_DEV_PORT + 1,
    },
    watch: {
      // The Rust crate has its own watcher; ignore it from Vite.
      ignored: ["**/src-tauri/**", "../backend/**"],
    },
  },

  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          motion: ["motion"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
