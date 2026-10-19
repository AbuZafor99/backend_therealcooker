import AppError from "../errors/AppError.js";

// Calendar reporting periods in the configured reporting timezone. Weeks run Sunday 00:00 to the next
// Sunday 00:00 and months from the 1st to the 1st of the next month. Every range is half-open
// [start, end), so an event exactly on a boundary belongs to exactly one period.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const formatters = new Map();
const validZone = zone => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };
export const reportingTimezone = () => {
  const zone = process.env.REPORTING_TIMEZONE;
  return zone && validZone(zone) ? zone : "UTC";
};

function zonedParts(instant, zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: WEEKDAYS.indexOf(parts.weekday) };
}
const offsetAt = (instant, zone) => {
  const seconds = Math.floor(instant / 1000) * 1000, p = zonedParts(seconds, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - seconds;
};

// UTC instant at which the given calendar date begins in the zone. Day and month overflow roll over
// (day 32 is the 1st of the next month), which keeps period arithmetic simple.
export function startOfLocalDay(year, month, day, zone = reportingTimezone()) {
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall - offsetAt(wall, zone);
  const corrected = wall - offsetAt(instant, zone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}
const isoDate = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
export const localDate = (instant, zone = reportingTimezone()) => {
  const { year, month, day, weekday } = zonedParts(instant, zone);
  return { year, month, day, weekday, iso: isoDate(year, month, day) };
};
export const startOfToday = (now = new Date(), zone = reportingTimezone()) => {
  const { year, month, day } = localDate(now, zone);
  return startOfLocalDay(year, month, day, zone);
};

const labelFormat = (options) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new AppError(400, "date must be in YYYY-MM-DD format");
  const [year, month, day] = String(value).split("-").map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new AppError(400, "date is not a valid calendar date");
  return { year, month, day, weekday: check.getUTCDay() };
}

// The week (Sunday–Saturday) or calendar month containing `date` (default: today in the zone).
// `through` is the exclusive upper bound to query with: the period end, or now for the current period.
export function reportingPeriod({ period = "week", date } = {}, now = new Date(), zone = reportingTimezone()) {
  if (!["week", "month"].includes(period)) throw new AppError(400, "period must be week or month");
  const anchor = date ? parseDate(date) : localDate(now, zone);
  const [first, next] = period === "week"
    ? [[anchor.year, anchor.month, anchor.day - anchor.weekday], [anchor.year, anchor.month, anchor.day - anchor.weekday + 7]]
    : [[anchor.year, anchor.month, 1], [anchor.year, anchor.month + 1, 1]];
  const start = startOfLocalDay(...first, zone), end = startOfLocalDay(...next, zone);
  if (start > now) throw new AppError(400, "Reports are not available for future periods");
  const startDate = isoDate(...first), lastDate = isoDate(next[0], next[1], next[2] - 1);
  const short = labelFormat({ day: "numeric", month: "short" }), long = labelFormat({ day: "numeric", month: "short", year: "numeric" });
  const label = period === "week"
    ? `${short.format(new Date(startDate))} – ${long.format(new Date(lastDate))}`
    : labelFormat({ month: "long", year: "numeric" }).format(new Date(startDate));
  return { period, timezone: zone, start, end, through: end < now ? end : now, isCurrent: now < end, startDate, lastDate, label };
}

export function previousPeriod(current, now = new Date()) {
  const [year, month, day] = current.startDate.split("-").map(Number);
  return reportingPeriod({ period: current.period, date: isoDate(year, month, day - 1) }, now, current.timezone);
}

// Local calendar dates covered so far by the period, oldest first.
export function periodDays(current, now = new Date()) {
  const last = current.isCurrent ? localDate(now, current.timezone).iso : current.lastDate;
  const [year, month, day] = current.startDate.split("-").map(Number);
  const days = [];
  for (let offset = 0; ; offset++) {
    const iso = isoDate(year, month, day + offset);
    if (iso > last) break;
    days.push(iso);
  }
  return days;
}

// The last `count` local calendar days ending today, as a half-open range plus their dates.
export function recentDays(count, now = new Date(), zone = reportingTimezone()) {
  const today = localDate(now, zone);
  const start = startOfLocalDay(today.year, today.month, today.day - count + 1, zone);
  return { start, through: now, days: Array.from({ length: count }, (_, index) => isoDate(today.year, today.month, today.day - count + 1 + index)) };
}
