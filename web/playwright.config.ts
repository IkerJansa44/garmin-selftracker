import { defineConfig, devices } from "@playwright/test";

const API_URL = "http://127.0.0.1:8190";
const WEB_URL = "http://127.0.0.1:5190";
const PYTHON = process.env.E2E_PYTHON ?? ".venv/bin/python";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: WEB_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `${PYTHON} tests/e2e/api_server.py --port 8190`,
      cwd: "..",
      reuseExistingServer: false,
      timeout: 30_000,
      url: `${API_URL}/api/health`,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 5190",
      env: { VITE_PROXY_TARGET: API_URL },
      reuseExistingServer: false,
      timeout: 30_000,
      url: WEB_URL,
    },
  ],
});
