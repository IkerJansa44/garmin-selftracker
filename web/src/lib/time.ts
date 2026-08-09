const DAY_MINUTES = 24 * 60;
export const TIME_STEP_MINUTES = 15;
export const TIME_SLIDER_MINUTES = { min: 0, max: DAY_MINUTES - TIME_STEP_MINUTES };

export function formatMinutesAsClock(minutes: number): string {
  const bounded = Math.min(TIME_SLIDER_MINUTES.max, Math.max(TIME_SLIDER_MINUTES.min, minutes));
  const hours = Math.floor(bounded / 60);
  const remainingMinutes = bounded % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainingMinutes).padStart(2, "0")}`;
}

export function stepClockMinutes(minutes: number | null, direction: -1 | 1): number {
  const current = minutes ?? TIME_SLIDER_MINUTES.min;
  return (current + direction * TIME_STEP_MINUTES + DAY_MINUTES) % DAY_MINUTES;
}

export function formatMinutesAsHours(minutes: number | null): string {
  if (minutes === null) return "--";
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function formatSecondsAsHours(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--";
  return formatMinutesAsHours(Math.round(seconds / 60));
}

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

export function timeToSleepGapMinutes(
  eventTime: string,
  sleepTime: string,
): number | null {
  const eventMinutes = parseClockTimeToMinutes(eventTime);
  const sleepMinutes = parseClockTimeToMinutes(sleepTime);
  if (eventMinutes === null || sleepMinutes === null) {
    return null;
  }
  if (sleepMinutes >= eventMinutes) {
    return sleepMinutes - eventMinutes;
  }
  return 24 * 60 - eventMinutes + sleepMinutes;
}

export function mealToSleepGapMinutes(
  mealTime: string,
  sleepTime: string,
): number | null {
  return timeToSleepGapMinutes(mealTime, sleepTime);
}

export function caffeineToSleepGapMinutes(
  caffeineTime: string,
  sleepTime: string,
): number | null {
  return timeToSleepGapMinutes(caffeineTime, sleepTime);
}
