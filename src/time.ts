// Time helpers. The Worker runs in UTC, so everything "local" goes through
// the configured IANA time zone (Lindsey's), never the runtime's clock zone.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: WEEKDAYS.indexOf(out.weekday),
  };
}

/** Offset of `tz` from UTC at `instant`, in minutes (e.g. -420 for PDT). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(instant.getTime() / 60000) * 60000;
  return Math.round((asUtc - truncated) / 60000);
}

/** The instant at which the wall clock in `tz` reads the given local time. */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle DST edges.
  let t = guess - offsetMinutes(new Date(guess), tz) * 60000;
  t = guess - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** "YYYY-MM-DD" for the local date of `instant`. */
export function localDate(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Adds whole days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** Local midnight of a "YYYY-MM-DD" date, as an instant. */
export function startOfLocalDay(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return zonedInstant(y, m, d, 0, 0, tz);
}

/** ISO 8601 with the local offset, e.g. 2026-10-21T13:20:00-07:00. */
export function isoLocal(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  const off = offsetMinutes(instant, tz);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** "3:00" style clock time, no AM/PM (used in compact lines). */
export function shortClock(instant: Date, tz: string): string {
  const p = localParts(instant, tz);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h}:${pad(p.minute)}`;
}

/** "1h 40m", "25m", "3h". */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

/** "Thu 22" for a "YYYY-MM-DD" date. */
export function shortDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WEEKDAYS[wd]} ${d}`;
}

/** "Oct 16" for a "YYYY-MM-DD" date. */
export function monthDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

/** Whole days between two "YYYY-MM-DD" dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86400000);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
