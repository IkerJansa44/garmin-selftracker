import { shiftIsoDate } from "./dateAlignment";
import { defaultDraftAnswers } from "./mockData";
import { flattenQuestionFields, pruneHiddenChildAnswers } from "./questions";
import { type CheckInEntry, type CheckInQuestion } from "./types";

type CheckInDraftAnswers = Record<string, string | number | boolean>;

function mergeSourceIntoDraft(
  defaults: CheckInDraftAnswers,
  questions: CheckInQuestion[],
  sourceAnswers: CheckInDraftAnswers,
): CheckInDraftAnswers {
  const validFieldIds = new Set(flattenQuestionFields(questions).map((field) => field.id));
  const filteredSource = Object.fromEntries(
    Object.entries(sourceAnswers).filter(([key]) => validFieldIds.has(key)),
  );
  const merged = { ...defaults, ...filteredSource };
  return pruneHiddenChildAnswers(questions, merged);
}

export function resolveCheckinDraftAnswers(
  selectedDate: string,
  questions: CheckInQuestion[],
  entriesByDate: Record<string, CheckInEntry>,
): CheckInDraftAnswers {
  const defaults = defaultDraftAnswers(questions);
  const selectedEntry = entriesByDate[selectedDate];
  if (selectedEntry) {
    return mergeSourceIntoDraft(defaults, questions, selectedEntry.answers);
  }

  const previousDate = shiftIsoDate(selectedDate, -1);
  if (!previousDate) {
    return defaults;
  }

  const previousEntry = entriesByDate[previousDate];
  if (!previousEntry) {
    return defaults;
  }

  return mergeSourceIntoDraft(defaults, questions, previousEntry.answers);
}
