import { describe, expect, it } from "vitest";

import {
  buildSleepWindowChartStats,
  formatOvernightClockLabel,
  normalizeDashboardPlotPreferences,
  type DashboardPlotPreference,
} from "./dashboardPlots";

type PlotKey = `metric:${string}` | `garmin:${string}` | `question:${string}`;

const defaultDirection = (key: PlotKey) => (key.includes("stress") ? "lower" : "higher");

describe("normalizeDashboardPlotPreferences", () => {
  it("preserves duplicate keys and keeps unique ids", () => {
    const fallback: DashboardPlotPreference<PlotKey>[] = [];
    const payload = [
      { id: "stress-a", key: "metric:stress", direction: "lower" },
      { id: "stress-b", key: "metric:stress", direction: "lower" },
    ];

    const normalized = normalizeDashboardPlotPreferences(payload, fallback, defaultDirection);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].id).toBe("stress-a");
    expect(normalized[1].id).toBe("stress-b");
    expect(normalized[0].key).toBe("metric:stress");
    expect(normalized[1].key).toBe("metric:stress");
  });

  it("fills defaults for legacy entries", () => {
    const fallback: DashboardPlotPreference<PlotKey>[] = [];
    const payload = ["garmin:sleepConsistency"];

    const normalized = normalizeDashboardPlotPreferences(payload, fallback, defaultDirection);

    expect(normalized).toEqual([
      {
        id: "plot_1_garmin_sleepConsistency",
        key: "garmin:sleepConsistency",
        direction: "higher",
        aggregation: "daily",
        rolling: false,
        reduceMethod: "mean",
        chartStyle: "line",
      },
    ]);
  });

  it("auto-fixes duplicate ids", () => {
    const fallback: DashboardPlotPreference<PlotKey>[] = [];
    const payload = [
      { id: "plot-1", key: "metric:stress", direction: "lower" },
      { id: "plot-1", key: "metric:recoveryIndex", direction: "higher" },
    ];

    const normalized = normalizeDashboardPlotPreferences(payload, fallback, defaultDirection);

    expect(normalized).toHaveLength(2);
    expect(normalized[0].id).toBe("plot-1");
    expect(normalized[1].id).toBe("plot-1_2");
  });
});

describe("buildSleepWindowChartStats", () => {
  it("maps overnight sleep windows and computes averages", () => {
    const stats = buildSleepWindowChartStats([
      { date: "2026-02-01", fellAsleepAt: "23:00", wokeUpAt: "07:00", sleepConsistency: 21 },
      { date: "2026-02-02", fellAsleepAt: "22:30", wokeUpAt: "06:30", sleepConsistency: 27 },
    ]);

    expect(stats.points).toHaveLength(2);
    expect(stats.axisOffsetMinutes).toBe(22 * 60);
    expect(stats.points[0].sleepWindowBase).toBe(60);
    expect(stats.points[0].sleepWindowDuration).toBe(8 * 60);
    expect(stats.points[0].sleepConsistencyValue).toBe(21);
    expect(stats.points[0].sleepConsistencyPlotValue).toBeGreaterThan(stats.points[1].sleepConsistencyPlotValue ?? 0);
    expect(stats.points[1].sleepWindowBase).toBe(30);
    expect(stats.points[1].sleepWindowDuration).toBe(8 * 60);
    expect(stats.points[1].sleepConsistencyValue).toBe(27);
    expect(stats.averageBedtime).toBe(45);
    expect(stats.averageWakeTime).toBe(525);
    expect(stats.sleepConsistencyDomain).toEqual([21, 27]);
  });

  it("excludes missing bed or wake records from averages without dropping the line value", () => {
    const stats = buildSleepWindowChartStats([
      { date: "2026-02-01", fellAsleepAt: "23:30", wokeUpAt: "07:10", sleepConsistency: 18 },
      { date: "2026-02-02", fellAsleepAt: null, wokeUpAt: "06:30", sleepConsistency: 24 },
    ]);

    expect(stats.axisOffsetMinutes).toBe(23 * 60);
    expect(stats.averageBedtime).toBe(30);
    expect(stats.averageWakeTime).toBe(490);
    expect(stats.points[1].sleepWindowBase).toBeNull();
    expect(stats.points[1].sleepWindowDuration).toBeNull();
    expect(stats.points[1].sleepConsistencyValue).toBe(24);
    expect(stats.points[1].sleepConsistencyPlotValue).not.toBeNull();
    expect(stats.sleepConsistencyDomain).toEqual([18, 24]);
  });

  it("keeps bars when sleep consistency is missing", () => {
    const stats = buildSleepWindowChartStats([
      { date: "2026-02-01", fellAsleepAt: "23:15", wokeUpAt: "07:15", sleepConsistency: null },
      { date: "2026-02-02", fellAsleepAt: "23:00", wokeUpAt: "06:45" },
    ]);

    expect(stats.axisOffsetMinutes).toBe(22 * 60 + 30);
    expect(stats.points[0].sleepWindowBase).toBe(45);
    expect(stats.points[0].sleepWindowDuration).toBe(8 * 60);
    expect(stats.points[0].sleepConsistencyValue).toBeNull();
    expect(stats.points[0].sleepConsistencyPlotValue).toBeNull();
    expect(stats.points[1].sleepWindowBase).toBe(30);
    expect(stats.points[1].sleepWindowDuration).toBe(7 * 60 + 45);
    expect(stats.points[1].sleepConsistencyValue).toBeNull();
    expect(stats.points[1].sleepConsistencyPlotValue).toBeNull();
    expect(stats.sleepConsistencyDomain).toEqual([0, 1]);
  });
});

describe("formatOvernightClockLabel", () => {
  it("renders wrapped HH:MM labels", () => {
    expect(formatOvernightClockLabel(30 * 60 + 15)).toBe("06:15");
  });
});
