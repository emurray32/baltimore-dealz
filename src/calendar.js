// Happy-hour calendar feed (iCalendar / .ics). Zero dependencies.
// Only deals tagged happy_hour:true that would reach a board card.

import { isDealRenderable, isRenderable, WEEK } from "./deals.js";

const DAY_TO_BYDAY = {
  mon: "MO",
  tue: "TU",
  wed: "WE",
  thu: "TH",
  fri: "FR",
  sat: "SA",
  sun: "SU",
};

// mon=0 … sun=6 — matches WEEK order.
const DAY_OFFSET = Object.fromEntries(WEEK.map((d, i) => [d.key, i]));

// Anchor Monday used as the DTSTART date for weekly RRULEs. Any Monday works;
// clients expand RRULE forward from it. Must stay a real Monday.
const ANCHOR_MONDAY_UTC = Date.UTC(2026, 7, 3); // 2026-08-03

// America/New_York VTIMEZONE — enough for Google / Apple / Outlook to interpret
// TZID without inventing offsets. Standard US Eastern rules.
const VTIMEZONE_EASTERN = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

/** Escape text for ICS TEXT values (SUMMARY, DESCRIPTION, LOCATION). */
export function icsEscape(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\n");
}

/**
 * RFC 5545 §3.1 line folding: content lines ≤ 75 *octets* (not characters).
 * Continuation lines start with a single space (counts toward the 75).
 * Walks by UTF-16 code units that form a complete character so multi-byte
 * UTF-8 sequences (em dash, emoji) are never split across fold boundaries.
 */
export function icsFold(line) {
  const MAX = 75;
  if (Buffer.byteLength(line, "utf8") <= MAX) return line;

  const parts = [];
  let i = 0;
  let first = true;
  while (i < line.length) {
    const budget = first ? MAX : MAX - 1; // leading space on continuations
    let take = 0;
    let bytes = 0;
    while (i + take < line.length) {
      const code = line.charCodeAt(i + take);
      // Keep surrogate pairs together (one Unicode scalar / one UTF-8 char).
      let charLen = 1;
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        i + take + 1 < line.length
      ) {
        const lo = line.charCodeAt(i + take + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) charLen = 2;
      }
      const chunk = line.slice(i + take, i + take + charLen);
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (bytes + chunkBytes > budget) break;
      bytes += chunkBytes;
      take += charLen;
    }
    if (take === 0) {
      // Single character wider than budget (should not happen at 74+); force it.
      const code = line.charCodeAt(i);
      take =
        code >= 0xd800 && code <= 0xdbff && i + 1 < line.length ? 2 : 1;
    }
    const piece = line.slice(i, i + take);
    parts.push(first ? piece : ` ${piece}`);
    i += take;
    first = false;
  }
  return parts.join("\r\n");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Minutes past midnight → HHmmss for local civil time. */
export function minutesToIcsTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}${pad2(m)}00`;
}

/** YYYYMMDD for a calendar day offset from the anchor Monday. */
function dateYmdFromOffset(dayOffset) {
  const ms = ANCHOR_MONDAY_UTC + dayOffset * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

/** First WEEK day key present in `days`, in mon…sun board order. */
function firstDayKey(days) {
  for (const d of WEEK) {
    if (days.includes(d.key)) return d.key;
  }
  return days[0];
}

function byDayList(days) {
  return days
    .slice()
    .sort((a, b) => (DAY_OFFSET[a] ?? 0) - (DAY_OFFSET[b] ?? 0))
    .map((d) => DAY_TO_BYDAY[d])
    .filter(Boolean)
    .join(",");
}

/**
 * Happy-hour rows that would appear on the board for these venues.
 * Same gates as dealsForDay: verified venue, not held, happy_hour === true.
 */
export function happyHourRows(venues) {
  const rows = [];
  for (const venue of venues) {
    if (!isRenderable(venue)) continue;
    for (const deal of venue.deals ?? []) {
      if (!isDealRenderable(deal)) continue;
      if (deal.happy_hour !== true) continue;
      if (!Array.isArray(deal.days) || deal.days.length === 0) continue;
      rows.push({ venue, deal });
    }
  }
  return rows;
}

/**
 * Slot key for a deal within a venue+day-set.
 *
 * Start minutes identify the window when present so two happy hours on the
 * same days (Claddagh Thu 4–7 vs 7–close) get different UIDs. End is NOT part
 * of the slot — correcting an end time (Union Hill 1080→1110) must keep the
 * same UID so subscriber calendars update in place instead of orphaning.
 *
 * Untimed / all-day rows fall back to a normalized time_window string.
 */
export function dealSlot(deal) {
  if (Number.isInteger(deal.start) && deal.start >= 0) {
    return `s${deal.start}`;
  }
  if (typeof deal.time_window === "string" && deal.time_window.trim()) {
    const slug = deal.time_window
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
    if (slug) return `w${slug}`;
  }
  return "x";
}

/**
 * Identity UID: venue + sorted day set + window slot.
 * Days sorted alphabetically so source-array reorder is a no-op.
 * Domain-ish suffix keeps UIDs unique without claiming a real host.
 */
export function stableUid(venue, deal) {
  const days = [...deal.days].sort().join("");
  return `bd-hh-${venue.id}-${days}-${dealSlot(deal)}@baltimore-dealz`;
}

function itemLines(deal) {
  return (deal.items ?? []).map((i) => i.text).filter(Boolean);
}

function descriptionFor(venue, deal) {
  const lines = [];
  if (deal.time_window) lines.push(deal.time_window);
  for (const t of itemLines(deal)) lines.push(t);
  if (deal.prices_published === false) {
    lines.push("Prices not published by the venue.");
  }
  if (venue.address) lines.push(venue.address);
  if (venue.neighborhood) lines.push(venue.neighborhood);
  const url = deal.source_url || venue.source_url;
  if (url) lines.push(url);
  lines.push("Source: Baltimore Dealz — verify at the bar; deals change.");
  return lines.join("\n");
}

function summaryFor(venue, deal) {
  const items = itemLines(deal);
  // Prefer a short label: first item if it is a short HH label, else "Happy Hour".
  let label = "Happy Hour";
  if (items.length === 1 && items[0].length <= 40) {
    label = items[0];
  } else if (items[0] && /happy hour/i.test(items[0]) && items[0].length <= 40) {
    label = items[0];
  }
  const window = deal.time_window ? ` (${deal.time_window})` : "";
  return `${venue.name} — ${label}${window}`;
}

/**
 * One VEVENT for a happy-hour row.
 * Timed when both start and end are known minutes; otherwise all-day on the
 * deal's weekdays (honest when the venue only published a window string).
 */
export function veventLines(venue, deal, { now = new Date() } = {}) {
  const uid = stableUid(venue, deal);
  const dtstamp = formatUtcStamp(now);
  const byday = byDayList(deal.days);
  const first = firstDayKey(deal.days);
  const ymd = dateYmdFromOffset(DAY_OFFSET[first] ?? 0);
  const timed =
    Number.isInteger(deal.start) &&
    Number.isInteger(deal.end) &&
    deal.start >= 0 &&
    deal.end > deal.start &&
    deal.end < 1440;

  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
  ];

  if (timed) {
    const t0 = minutesToIcsTime(deal.start);
    const t1 = minutesToIcsTime(deal.end);
    lines.push(`DTSTART;TZID=America/New_York:${ymd}T${t0}`);
    lines.push(`DTEND;TZID=America/New_York:${ymd}T${t1}`);
  } else {
    // VALUE=DATE all-day; DTEND is exclusive next day per RFC 5545.
    lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    const next = dateYmdFromOffset((DAY_OFFSET[first] ?? 0) + 1);
    lines.push(`DTEND;VALUE=DATE:${next}`);
  }

  if (byday) {
    lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${byday}`);
  }

  lines.push(`SUMMARY:${icsEscape(summaryFor(venue, deal))}`);
  lines.push(`DESCRIPTION:${icsEscape(descriptionFor(venue, deal))}`);
  if (venue.address) {
    lines.push(`LOCATION:${icsEscape(venue.address)}`);
  }
  const url = deal.source_url || venue.source_url;
  if (url) {
    lines.push(`URL:${url}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

function formatUtcStamp(date) {
  const y = date.getUTCFullYear();
  const mo = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  const h = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const s = pad2(date.getUTCSeconds());
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

/**
 * Full .ics document for the given venues (already filtered to a view).
 * @param {object[]} venues
 * @param {{ calendarName?: string, now?: Date }} [options]
 */
export function buildHappyHourIcs(venues, options = {}) {
  const now = options.now ?? new Date();
  const name = options.calendarName ?? "Baltimore Dealz Happy Hours";
  const rows = happyHourRows(venues);

  // Stable order: by venue name, then first day, then start time.
  rows.sort((a, b) => {
    const n = a.venue.name.localeCompare(b.venue.name);
    if (n !== 0) return n;
    const da = DAY_OFFSET[firstDayKey(a.deal.days)] ?? 0;
    const db = DAY_OFFSET[firstDayKey(b.deal.days)] ?? 0;
    if (da !== db) return da - db;
    return (a.deal.start ?? -1) - (b.deal.start ?? -1);
  });

  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Baltimore Dealz//Happy Hours//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(name)}`,
    "X-WR-TIMEZONE:America/New_York",
    ...VTIMEZONE_EASTERN,
  ];

  for (const { venue, deal } of rows) {
    body.push(...veventLines(venue, deal, { now }));
  }

  body.push("END:VCALENDAR");

  // CRLF throughout; fold long content lines.
  return body.map(icsFold).join("\r\n") + "\r\n";
}
