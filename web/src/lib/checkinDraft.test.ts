import { describe, expect, it } from "vitest";

import { resolveCheckinDraftAnswers } from "./checkinDraft";
import { type CheckInEntry, type CheckInQuestion } from "./types";

const QUESTIONS: CheckInQuestion[] = [
  {
    id: "energy",
    section: "General",
    prompt: "Energy",
    inputType: "slider",
    analysisMode: "predictor_next_day",
    min: 1,
    max: 10,
    step: 1,
    defaultIncluded: true,
  },
  {
    id: "caffeine_count",
    section: "Nutrition",
    prompt: "Caffeine",
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
    id: "notes",
    section: "General",
    prompt: "Notes",
    inputType: "text",
    analysisMode: "predictor_next_day",
    defaultIncluded: true,
  },
];

function entry(date: string, answers: CheckInEntry["answers"]): CheckInEntry {
  return {
    date,
    answers,
    completedAt: `${date}T22:00:00Z`,
  };
}

describe("resolveCheckinDraftAnswers", () => {
  it("returns selected day saved answers when selected day exists", () => {
    const entriesByDate = {
      "2026-02-22": entry("2026-02-22", { energy: 5 }),
      "2026-02-23": entry("2026-02-23", { energy: 8 }),
    };

    expect(resolveCheckinDraftAnswers("2026-02-23", QUESTIONS, entriesByDate)).toEqual({
      energy: 8,
      caffeine_count: 0,
      notes: "",
    });
  });

  it("uses previous day answers for an unsaved selected day", () => {
    const entriesByDate = {
      "2026-02-22": entry("2026-02-22", { energy: 6, caffeine_count: 2, notes: "Late workout" }),
    };

    expect(resolveCheckinDraftAnswers("2026-02-23", QUESTIONS, entriesByDate)).toEqual({
      energy: 6,
      caffeine_count: 2,
      notes: "Late workout",
    });
  });

  it("falls back to defaults when selected and previous day are not saved", () => {
    expect(resolveCheckinDraftAnswers("2026-02-23", QUESTIONS, {})).toEqual({
      energy: 1,
      caffeine_count: 0,
      notes: "",
    });
  });

  it("falls back to defaults when selected date is invalid", () => {
    const entriesByDate = {
      "2026-02-22": entry("2026-02-22", { energy: 7, notes: "Copied value" }),
    };

    expect(resolveCheckinDraftAnswers("not-a-date", QUESTIONS, entriesByDate)).toEqual({
      energy: 1,
      caffeine_count: 0,
      notes: "",
    });
  });

  it("drops keys that are not present in the current question library", () => {
    const entriesByDate = {
      "2026-02-23": entry("2026-02-23", {
        energy: 8,
        notes: "Good day",
        deprecated_field: "stale",
      }),
    };

    expect(resolveCheckinDraftAnswers("2026-02-23", QUESTIONS, entriesByDate)).toEqual({
      energy: 8,
      caffeine_count: 0,
      notes: "Good day",
    });
  });

  it("keeps only visible child answers based on parent value", () => {
    const entriesByDate = {
      "2026-02-22": entry("2026-02-22", {
        energy: 6,
        caffeine_count: 0,
        caffeine_last_time: "16:30",
        notes: "No caffeine",
      }),
    };

    expect(resolveCheckinDraftAnswers("2026-02-23", QUESTIONS, entriesByDate)).toEqual({
      energy: 6,
      caffeine_count: 0,
      notes: "No caffeine",
    });
  });
});
