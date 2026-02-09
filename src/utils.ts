/**
 * Utility helpers: duration parsing and date helpers.
 */

/**
 * Parse a human-readable duration string into seconds.
 *
 * Supported formats: "2h", "30m", "1h30m", "1.5h", "90m", "2h 15m"
 */
export function parseDuration(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Empty duration string");
  }

  const pattern = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/i;
  const match = trimmed.match(pattern);

  if (match && (match[1] || match[2])) {
    const hours = match[1] ? parseFloat(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return Math.round(hours * 3600 + minutes * 60);
  }

  throw new Error(
    `Cannot parse duration '${text}'. Use formats like: 2h, 30m, 1h30m, 1.5h`
  );
}

/** Format seconds into a human-readable duration (e.g. "2h 30m"). */
export function formatSeconds(seconds: number): string {
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(" ") || "0m";
}

/** Parse a date string (ISO format like "2026-02-09") into a Date. */
export function parseDate(text: string): Date {
  const d = new Date(text);
  if (isNaN(d.getTime())) {
    throw new Error(`Cannot parse date '${text}'. Use ISO format like 2026-02-09`);
  }
  return d;
}

/** Format a Date as an ISO date string (YYYY-MM-DD). */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Get today's date as a YYYY-MM-DD string. */
export function today(): string {
  return formatDate(new Date());
}

/**
 * Return [monday, friday] of the week containing the given date.
 * If no date is given, uses today.
 */
export function getWeekBounds(ref?: Date): [Date, Date] {
  const d = ref ?? new Date();
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);

  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  return [monday, friday];
}

/** Return an array of dates from monday to friday (inclusive). */
export function weekdayRange(monday: Date, friday: Date): Date[] {
  const days: Date[] = [];
  const current = new Date(monday);
  while (current <= friday) {
    days.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return days;
}
