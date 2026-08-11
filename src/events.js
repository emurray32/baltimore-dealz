// Events are a separate feed from deals, on purpose.
//
// A deal is a price you can act on. An event is something happening on a date.
// A Ravens game is a date, not a deal — it becomes a deal only when a venue
// publishes its own watch-party offer, and that lives in venues.json with a
// price and a source like every other deal row. Mixing the two is how a board
// of specials turns back into a wall of undifferentiated text.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { BALTIMORE_TZ, WEEK, zonedYmd } from "./deals.js";

export const EVENTS_FILE = fileURLToPath(new URL("../data/events.json", import.meta.url));

// Read on every call, same as loadVenues — regenerating data/events.json is
// enough, no restart.
export async function loadEvents() {
  try {
    return JSON.parse(await readFile(EVENTS_FILE, "utf8")).events ?? [];
  } catch (err) {
    // A board with no events feed is a board with no events, not a 500.
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export const EVENT_CATEGORIES = ["sports", "community", "music"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVENT_KEYS = new Set(["id", "title", "date", "time", "place", "category", "source_url"]);

export function eventShapeErrors(event) {
  const errors = [];
  if (!event || typeof event !== "object") return ["event must be an object"];
  const label = event.id ?? "(no id)";

  for (const field of ["id", "title"]) {
    if (typeof event[field] !== "string" || event[field] === "") {
      errors.push(`${label}: ${field} must be a non-empty string`);
    }
  }
  if (!DATE_RE.test(event.date ?? "")) errors.push(`${label}: date must be YYYY-MM-DD`);
  // Optional: an all-day event has no clock time.
  if (event.time !== undefined && !TIME_RE.test(event.time)) {
    errors.push(`${label}: time must be HH:MM in 24-hour form when present`);
  }
  if (event.place !== undefined && (typeof event.place !== "string" || event.place === "")) {
    errors.push(`${label}: place must be a non-empty string when present`);
  }
  if (!EVENT_CATEGORIES.includes(event.category)) {
    errors.push(`${label}: category must be one of ${EVENT_CATEGORIES.join(", ")}`);
  }
  // Same standard as a deal row: an event nobody can check is not publishable.
  if (typeof event.source_url !== "string" || !/^https?:\/\//.test(event.source_url)) {
    errors.push(`${label}: source_url must be an http(s) URL`);
  }
  for (const key of Object.keys(event)) {
    if (!EVENT_KEYS.has(key)) errors.push(`${label}: unknown field "${key}" on an event`);
  }
  return errors;
}

export function eventsOnDate(events, isoDate) {
  return events
    .filter((e) => e.date === isoDate)
    .sort((a, b) => (a.time ?? "").localeCompare(b.time ?? "") || a.title.localeCompare(b.title));
}

export function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Baltimore's "today" as an ISO date, so the calendar highlights the same day
// the board calls tonight.
export function todayIso(now = new Date(), timeZone = BALTIMORE_TZ) {
  const { year, month, day } = zonedYmd(now, timeZone);
  return isoDate(year, month, day);
}

export function monthLabel(year, month) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function addMonths(year, month, delta) {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

// A Monday-first grid of whole weeks covering the month, so every row has seven
// cells and the template never has to special-case a ragged edge. Days outside
// the month are still returned, flagged, because the grid needs to fill them.
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekdayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][first.getUTCDay()];
  const lead = WEEK.findIndex((d) => d.key === firstWeekdayKey);
  const daysThisMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const total = Math.ceil((lead + daysThisMonth) / 7) * 7;

  const cells = [];
  for (let i = 0; i < total; i += 1) {
    const d = new Date(Date.UTC(year, month - 1, 1 - lead + i));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    cells.push({
      iso: isoDate(y, m, day),
      day,
      inMonth: m === month && y === year,
      dayKey: WEEK[i % 7].key,
      // Noon UTC keeps the recurrence question on the right calendar day.
      date: new Date(Date.UTC(y, m - 1, day, 12)),
    });
  }
  return cells;
}
