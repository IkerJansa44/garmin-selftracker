import { type DailyRecord } from "./types";

export function getZone2PlusMinutes(predictors: DailyRecord["predictors"]): number | null {
  const values = [
    predictors.zone2Minutes,
    predictors.zone3Minutes,
    predictors.zone4Minutes,
    predictors.zone5Minutes,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!values.length) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0);
}
