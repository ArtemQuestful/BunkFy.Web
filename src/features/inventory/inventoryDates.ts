export function propertyLocalDateKey(
  timeZoneId: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZoneId,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) {
    throw new RangeError(`Cannot resolve the business date for ${timeZoneId}.`);
  }

  return `${year}-${month}-${day}`;
}

export function addCalendarDays(dateKey: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new RangeError(`Invalid date key: ${dateKey}.`);

  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function defaultInventoryRange(
  timeZoneId: string,
  now: Date = new Date(),
): { arrival: string; departure: string } {
  const today = propertyLocalDateKey(timeZoneId, now);
  const arrival = addCalendarDays(today, 1);
  return { arrival, departure: addCalendarDays(arrival, 2) };
}
