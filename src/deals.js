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

// Only "verified" venues reach the board. Everything else — a venue we know is
// open but can't source a deal for — stays in the data file and never renders.
export const VERIFIED = "verified";

export function isRenderable(venue) {
  return venue.status === VERIFIED;
}

// A view is a named board that can span more than one neighborhood.
export function venuesForView(venues, view) {
  return venues.filter(
    (venue) => isRenderable(venue) && view.neighborhoods.includes(venue.neighborhood),
  );
}

// A single deal row can be held back while the rest of the venue still shows —
// a deal whose days or hours we can't yet state honestly. Absent status renders.
export const HELD = "held";

export function isDealRenderable(deal) {
  return deal.status === undefined;
}

// Flattens venues into one row per deal running on dayKey. The status checks are
// repeated here on purpose: no caller can put an unverified venue, or a held
// deal row, on the board.
export function dealsForDay(venues, dayKey) {
  const rows = [];
  for (const venue of venues) {
    if (!isRenderable(venue)) continue;
    for (const deal of venue.deals) {
      if (!isDealRenderable(deal)) continue;
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

export const STATUSES = [VERIFIED, "open_unverifiable"];

// The only status a deal row may carry. Anything else is a typo or a hand-rolled
// hold field, and both must fail the suite rather than quietly render the deal.
export const DEAL_STATUSES = [HELD];
const DEAL_KEYS = new Set(["days", "items", "time_window", "status"]);

const DAY_KEYS = new Set(WEEK.map((day) => day.key));

// Returns a list of problems, empty when the venue is well formed. The rules are
// stricter for venues that render: a venue nobody will see may be missing the
// details we simply could not source (Claddagh has no working site at all).
export function venueShapeErrors(venue) {
  const errors = [];
  const label = venue?.id ?? "(no id)";
  const requireString = (field) => {
    if (typeof venue[field] !== "string" || venue[field] === "") {
      errors.push(`${label}: ${field} must be a non-empty string`);
    }
  };

  if (!venue || typeof venue !== "object") return ["venue must be an object"];

  for (const field of ["id", "name", "neighborhood"]) requireString(field);
  if (!STATUSES.includes(venue.status)) {
    errors.push(`${label}: status must be one of ${STATUSES.join(", ")}`);
  }
  for (const field of ["address", "phone", "source_url", "source_type", "notes", "neighborhood_source"]) {
    if (venue[field] !== undefined && typeof venue[field] !== "string") {
      errors.push(`${label}: ${field} must be a string when present`);
    }
  }
  if (!Array.isArray(venue.deals)) {
    errors.push(`${label}: deals must be an array`);
    return errors;
  }

  if (isRenderable(venue)) {
    requireString("source_type");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(venue.last_verified ?? "")) {
      errors.push(`${label}: last_verified must be YYYY-MM-DD`);
    }
    if (venue.deals.length === 0) {
      errors.push(`${label}: a venue that renders needs at least one deal`);
    }
  }

  for (const deal of venue.deals) {
    if (!Array.isArray(deal.days) || deal.days.length === 0) {
      errors.push(`${label}: deal needs days`);
    } else {
      for (const day of deal.days) {
        if (!DAY_KEYS.has(day)) errors.push(`${label}: unknown day "${day}"`);
      }
    }
    if (!Array.isArray(deal.items) || deal.items.length === 0) {
      errors.push(`${label}: deal needs items`);
    }
    if (deal.time_window !== undefined && typeof deal.time_window !== "string") {
      errors.push(`${label}: time_window must be a string when present`);
    }
    if (deal.status !== undefined && !DEAL_STATUSES.includes(deal.status)) {
      errors.push(
        `${label}: deal status must be omitted or one of ${DEAL_STATUSES.join(", ")}`,
      );
    }
    // An unknown key here is almost always someone inventing their own way to
    // hold a row back. Silently ignoring it would render the deal anyway.
    for (const key of Object.keys(deal)) {
      if (!DEAL_KEYS.has(key)) errors.push(`${label}: unknown field "${key}" on a deal`);
    }
  }

  return errors;
}
