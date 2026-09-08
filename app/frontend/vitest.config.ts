import { defineConfig, mergeConfig } from "vitest/config";
import { appViteConfig } from "./vite.config.ts";

export default mergeConfig(
  appViteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      coverage: {
        provider: "v8",
        reporter: ["text", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.{test,spec}.{ts,tsx}",
          "src/test/**",
          "src/main.tsx",
          "src/vite-env.d.ts",
        ],
      },
    },
  })
);
