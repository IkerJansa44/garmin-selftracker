import { describe, expect, it } from "vitest";

import {
  predictorDateForOutcomeDate,
  sleepMetricDateForPredictorDate,
  shiftIsoDate,
  sleepSourceDayFromMetricDate,
} from "./dateAlignment";

describe("dateAlignment", () => {
  it("shifts ISO dates across month and year boundaries", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles leap year rollover", () => {
    expect(shiftIsoDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("maps predictor and sleep source dates to D-1", () => {
    expect(predictorDateForOutcomeDate("2026-02-21")).toBe("2026-02-20");
    expect(sleepSourceDayFromMetricDate("2026-02-21")).toBe("2026-02-20");
  });

  it("maps sleep predictors for a check-in day to Garmin metric day D+1", () => {
    expect(sleepMetricDateForPredictorDate("2026-02-20")).toBe("2026-02-21");
  });
});
