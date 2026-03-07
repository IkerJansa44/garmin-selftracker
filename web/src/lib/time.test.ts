import { describe, expect, it } from "vitest";

import { caffeineToSleepGapMinutes, mealToSleepGapMinutes, timeToSleepGapMinutes } from "./time";

describe("timeToSleepGapMinutes", () => {
  it("handles overnight gap from previous day meal to next day sleep", () => {
    expect(timeToSleepGapMinutes("23:15", "01:30")).toBe(135);
  });

  it("supports caffeine and meal wrappers", () => {
    expect(mealToSleepGapMinutes("21:00", "23:00")).toBe(120);
    expect(caffeineToSleepGapMinutes("18:45", "00:30")).toBe(345);
  });
});
