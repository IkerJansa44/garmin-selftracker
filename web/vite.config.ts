import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const DEFAULT_ALLOWED_HOSTS = ["ikers-macbook-pro"];

function parseAllowedHosts(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");

  return {
    plugins: [react()],
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
    server: {
      allowedHosts: [...DEFAULT_ALLOWED_HOSTS, ...parseAllowedHosts(env.ALLOWED_HOSTS ?? "")],
      host: true,
      port: 5180,
      proxy: {
        "/api": {
          target: env.VITE_PROXY_TARGET || "http://localhost:8000",
          changeOrigin: true,
        },
      },
    },
  };
});
