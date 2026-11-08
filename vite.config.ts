import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.BUNKFY_DEV_PROXY_TARGET?.trim();

  return {
    base: process.env.VITE_PUBLIC_BASE_PATH || env.VITE_PUBLIC_BASE_PATH || "/",
    plugins: [react(), tailwindcss()],
    test: {
      // Each native suite starts Vite and Chromium. Keep CI browser fixtures
      // from competing for CPU; Windows also needs bounded socket use.
      maxWorkers: process.env.CI || process.platform === "win32" ? 1 : 2,
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
