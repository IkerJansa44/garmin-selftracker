import { describe, expect, it } from "vitest";

import { getZone2PlusMinutes } from "./heartRateZones";
import { type DailyRecord } from "./types";

function buildPredictors(
  overrides: Partial<DailyRecord["predictors"]> = {},
): DailyRecord["predictors"] {
  return {
    steps: null,
    calories: null,
    stressAvg: null,
    bodyBattery: null,
    sleepSeconds: null,
    sleepConsistency: null,
    isTrainingDay: false,
    zone0Minutes: null,
    zone1Minutes: null,
    zone2Minutes: null,
    zone3Minutes: null,
    zone4Minutes: null,
    zone5Minutes: null,
    mealToSleepGapMinutes: null,
    caffeineToSleepGapMinutes: null,
    ...overrides,
  };
}

describe("getZone2PlusMinutes", () => {
  it("sums time from zones 2 through 5", () => {
    const value = getZone2PlusMinutes(
      buildPredictors({
        zone1Minutes: 40,
        zone2Minutes: 35,
        zone3Minutes: 20,
        zone4Minutes: 10,
        zone5Minutes: 5,
      }),
    );

    expect(value).toBe(70);
  });

  it("returns null when all upper-zone values are missing", () => {
    const value = getZone2PlusMinutes(
      buildPredictors({
        zone0Minutes: 15,
        zone1Minutes: 30,
      }),
    );

    expect(value).toBeNull();
  });
});
