import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.BUNKFY_DEV_PROXY_TARGET?.trim();

  return {
    plugins: [react(), tailwindcss()],
    test: {
      // Each native suite owns Vite and Chromium. Bound Windows concurrency
      // after observed ERR_NO_BUFFER_SPACE failures in parallel browser suites.
      maxWorkers: process.platform === "win32" ? 1 : 2,
    },
    server: {
      host: "0.0.0.0",
      proxy: proxyTarget ? {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
        },
      } : undefined,
    },
    preview: {
      host: "0.0.0.0",
    },
  };
});
