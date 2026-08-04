// Pure deal-selection logic. No I/O here so it can be unit tested directly.

export const BALTIMORE_TZ = "America/New_York";

// Ordered Mon-first, which is how the week reads on the board.
export const WEEK = [
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

const WEEKDAY_FORMATTERS = new Map();

function weekdayFormatter(timeZone) {
  let formatter = WEEKDAY_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
    WEEKDAY_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

// Which day is it *in Baltimore*, not on whatever machine is serving the page.
export function dayKeyInZone(date, timeZone = BALTIMORE_TZ) {
  return weekdayFormatter(timeZone).format(date).toLowerCase();
}

export function dayLabel(dayKey) {
  return WEEK.find((day) => day.key === dayKey)?.label ?? dayKey;
}

// Flattens venues into one row per deal running on dayKey.
export function dealsForDay(venues, dayKey) {
  const rows = [];
  for (const venue of venues) {
    for (const deal of venue.deals) {
      if (deal.days.includes(dayKey)) {
        rows.push({ venue, deal });
      }
    }
  }
  return rows;
}

export function weekByDay(venues) {
  return WEEK.map((day) => ({ ...day, rows: dealsForDay(venues, day.key) }));
}
