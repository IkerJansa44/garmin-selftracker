export function parseClockTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}

export function mealToSleepGapMinutes(
  mealTime: string,
  sleepTime: string,
): number | null {
  const mealMinutes = parseClockTimeToMinutes(mealTime);
  const sleepMinutes = parseClockTimeToMinutes(sleepTime);
  if (mealMinutes === null || sleepMinutes === null) {
    return null;
  }
  if (sleepMinutes >= mealMinutes) {
    return sleepMinutes - mealMinutes;
  }
  return 24 * 60 - mealMinutes + sleepMinutes;
}
