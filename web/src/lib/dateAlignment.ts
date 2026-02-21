const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDateParts(value: string): { year: number; month: number; day: number } | null {
  if (!ISO_DATE_PATTERN.test(value)) {
    return null;
  }
  const [year, month, day] = value.split("-").map((entry) => Number(entry));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

export function shiftIsoDate(value: string, offsetDays: number): string | null {
  const parsed = parseIsoDateParts(value);
  if (!parsed) {
    return null;
  }
  const shifted = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

export function predictorDateForOutcomeDate(outcomeDate: string): string | null {
  return shiftIsoDate(outcomeDate, -1);
}

export function sleepSourceDayFromMetricDate(metricDate: string): string | null {
  return shiftIsoDate(metricDate, -1);
}

export function sleepMetricDateForPredictorDate(predictorDate: string): string | null {
  return shiftIsoDate(predictorDate, 1);
}
