import { afterEach, expect, it, vi } from "vitest";
import { appPath } from "../../src/lib/appPath";
import { fetchDashboardData } from "../../src/lib/api";
import { registerServiceWorker } from "../../src/pwa";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["/", "/garmin-joan/", "/nil-garmin/"])("keeps requests and service workers under %s", async (base) => {
  vi.stubEnv("BASE_URL", base);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  const register = vi.fn().mockResolvedValue({});
  vi.stubGlobal("navigator", { serviceWorker: { register } });

  await fetchDashboardData(30);
  expect(fetchMock.mock.calls[0][0]).toBe(`${base}api/dashboard?days=30`);
  expect(appPath("/api/monthly-reports/2026-08/pdf")).toBe(`${base}api/monthly-reports/2026-08/pdf`);
  await registerServiceWorker();
  expect(register).toHaveBeenCalledWith(`${base}sw.js`, { scope: base });
});
