import { describe, expect, it } from "vitest";

import { mealToSleepGapMinutes } from "./time";

describe("mealToSleepGapMinutes", () => {
  it("handles overnight gap from previous day meal to next day sleep", () => {
    expect(mealToSleepGapMinutes("23:15", "01:30")).toBe(135);
  });
});
