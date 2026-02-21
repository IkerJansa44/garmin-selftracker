import { describe, expect, it } from "vitest";

import { getVisibleChildren, pruneHiddenChildAnswers } from "./questions";
import { type CheckInQuestion } from "./types";

const QUESTIONS: CheckInQuestion[] = [
  {
    id: "caffeine_count",
    section: "Nutrition",
    prompt: "Caffeine",
    inputLabel: "Count",
    inputType: "slider",
    analysisMode: "predictor_next_day",
    min: 0,
    max: 8,
    step: 1,
    children: [
      {
        id: "caffeine_last_time",
        prompt: "Last caffeine drink",
        inputType: "time",
        analysisMode: "predictor_next_day",
        condition: { operator: "greater_than", value: 0 },
      },
    ],
    defaultIncluded: true,
  },
  {
    id: "alcohol_units",
    section: "Nutrition",
    prompt: "Alcohol",
    inputType: "multi-choice",
    analysisMode: "predictor_next_day",
    options: [
      { id: "0", label: "0", score: 0 },
      { id: "1", label: "1", score: 1 },
      { id: "2", label: "2", score: 2 },
      { id: "3plus", label: "3+", score: 3 },
    ],
    children: [
      {
        id: "alcohol_last_time",
        prompt: "Last alcohol drink",
        inputType: "time",
        analysisMode: "predictor_next_day",
        condition: { operator: "greater_than", value: 0 },
      },
    ],
    defaultIncluded: true,
  },
];

describe("question tree helpers", () => {
  it("shows child fields only when condition matches", () => {
    expect(
      getVisibleChildren(QUESTIONS[0], { caffeine_count: 2 }).map((child) => child.id),
    ).toEqual(["caffeine_last_time"]);
    expect(
      getVisibleChildren(QUESTIONS[0], { caffeine_count: 0 }).map((child) => child.id),
    ).toEqual([]);
  });

  it("uses option score for multi-choice child conditions", () => {
    expect(
      getVisibleChildren(QUESTIONS[1], { alcohol_units: "3plus" }).map((child) => child.id),
    ).toEqual(["alcohol_last_time"]);
    expect(
      getVisibleChildren(QUESTIONS[1], { alcohol_units: "0" }).map((child) => child.id),
    ).toEqual([]);
  });

  it("clears hidden child values from answers", () => {
    const answers = pruneHiddenChildAnswers(QUESTIONS, {
      caffeine_count: 0,
      caffeine_last_time: "15:20",
      alcohol_units: "3plus",
      alcohol_last_time: "20:45",
    });
    expect(answers.caffeine_last_time).toBeUndefined();
    expect(answers.alcohol_last_time).toBe("20:45");
  });
});

