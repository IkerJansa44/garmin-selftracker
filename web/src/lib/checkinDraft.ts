import { shiftIsoDate } from "./dateAlignment";
import { defaultDraftAnswers } from "./mockData";
import { type CheckInEntry, type CheckInQuestion } from "./types";

type CheckInDraftAnswers = Record<string, string | number | boolean>;

export function resolveCheckinDraftAnswers(
  selectedDate: string,
  questions: CheckInQuestion[],
  entriesByDate: Record<string, CheckInEntry>,
): CheckInDraftAnswers {
  const defaults = defaultDraftAnswers(questions);
  const selectedEntry = entriesByDate[selectedDate];
  if (selectedEntry) {
    return { ...defaults, ...selectedEntry.answers };
  }

  const previousDate = shiftIsoDate(selectedDate, -1);
  if (!previousDate) {
    return defaults;
  }

  const previousEntry = entriesByDate[previousDate];
  if (!previousEntry) {
    return defaults;
  }

  return { ...defaults, ...previousEntry.answers };
}
