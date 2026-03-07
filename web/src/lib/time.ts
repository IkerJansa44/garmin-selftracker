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
