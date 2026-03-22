import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
    server: {
      allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS ?? ""),
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
