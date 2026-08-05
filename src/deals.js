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

// Only "verified" venues can contribute deal cards. Everything else — a venue we
// know is open but can't source a deal for — still appears in the collapsed
// "no deals we can show" group (name + reason), never as a deal card.
export const VERIFIED = "verified";

export function isRenderable(venue) {
  return venue.status === VERIFIED;
}

// Every venue in the view's neighborhoods, including those with nothing to show.
export function venuesInView(venues, view) {
  return venues.filter((venue) => view.neighborhoods.includes(venue.neighborhood));
}

// Verified venues only — used by deal selection and older callers.
export function venuesForView(venues, view) {
  return venuesInView(venues, view).filter(isRenderable);
}

// A single deal row can be held back while the rest of the venue still shows —
// a deal whose days or hours we can't yet state honestly. Absent status renders.
export const HELD = "held";

export function isDealRenderable(deal) {
  return deal.status === undefined;
}

// At least one deal row that would actually reach a card. A verified venue whose
// only deals are held (El Bufalo) has nothing showable — same honest treatment
// as open_unverifiable.
export function hasShowableDeal(venue) {
  return isRenderable(venue) && venue.deals.some(isDealRenderable);
}

// Name + reason group: open but no published deal we can state, OR every deal held.
export function noDealVenues(venues) {
  return venues.filter((venue) => !hasShowableDeal(venue));
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

// Legend for venue.source_type. Free strings (e.g. "website_text") used to pass;
// unknown values now fail the suite so the data cannot drift off the legend.
export const SOURCE_TYPES = ["venue_website", "instagram_profile", "none"];

// The only status a deal row may carry. Anything else is a typo or a hand-rolled
// hold field, and both must fail the suite rather than quietly render the deal.
export const DEAL_STATUSES = [HELD];
const DEAL_KEYS = new Set([
  "days", "items", "time_window", "start", "end", "prices_published", "status",
  // The URL that actually verified this row — may differ from the venue homepage.
  "source_url",
]);
const ITEM_KEYS = new Set(["text", "price"]);

// A venue that publishes its deals in a form we cannot machine-read.
export const DEAL_FORMATS = ["image"];

// Minutes past midnight, or null. `end: null` MEANS the venue published no end
// time — so hasEnded can never be true for it. That is the whole point of the
// split: the canon stops being a rule someone remembers and becomes a shape.
export function hasEnded(deal, minutesNow) {
  if (deal.end === null || deal.end === undefined) return false;
  return minutesNow >= deal.end;
}

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
  for (const field of ["address", "phone", "source_url", "source_type", "notes_public", "ops_notes", "bar_hours", "neighborhood_source", "coords_source"]) {
    if (venue[field] !== undefined && typeof venue[field] !== "string") {
      errors.push(`${label}: ${field} must be a string when present`);
    }
  }
  if (venue.source_type !== undefined && !SOURCE_TYPES.includes(venue.source_type)) {
    errors.push(
      `${label}: source_type must be one of ${SOURCE_TYPES.join(", ")}`,
    );
  }
  for (const field of ["lat", "lon"]) {
    if (venue[field] !== undefined && typeof venue[field] !== "number") {
      errors.push(`${label}: ${field} must be a number when present`);
    }
  }
  // Coordinates travel as a pair with provenance. One without the other is a typo.
  const hasLat = venue.lat !== undefined;
  const hasLon = venue.lon !== undefined;
  if (hasLat !== hasLon) {
    errors.push(`${label}: lat and lon must both be set or both omitted`);
  }
  if ((hasLat || hasLon) && !venue.coords_source) {
    errors.push(`${label}: coords_source is required when lat/lon are set`);
  }
  if (venue.deal_format !== undefined && !DEAL_FORMATS.includes(venue.deal_format)) {
    errors.push(`${label}: deal_format must be omitted or one of ${DEAL_FORMATS.join(", ")}`);
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
    } else {
      for (const item of deal.items) {
        if (typeof item?.text !== "string" || item.text === "") {
          errors.push(`${label}: every item needs non-empty text`);
        }
        // A price is free text: "BOGO", "1/2 off" and "Free" are real prices
        // that a number cannot hold. Absent means the item has no price.
        if (item?.price !== undefined && (typeof item.price !== "string" || item.price === "")) {
          errors.push(`${label}: item price must be a non-empty string when present`);
        }
        for (const key of Object.keys(item ?? {})) {
          if (!ITEM_KEYS.has(key)) errors.push(`${label}: unknown field "${key}" on an item`);
        }
      }
    }
    for (const field of ["start", "end"]) {
      const v = deal[field];
      if (v !== null && !(Number.isInteger(v) && v >= 0 && v < 1440)) {
        errors.push(`${label}: ${field} must be null or minutes past midnight`);
      }
    }
    if (deal.prices_published !== undefined && deal.prices_published !== false) {
      errors.push(`${label}: prices_published may only be present as false`);
    }
    if (deal.time_window !== undefined && typeof deal.time_window !== "string") {
      errors.push(`${label}: time_window must be a string when present`);
    }
    if (deal.source_url !== undefined && (typeof deal.source_url !== "string" || deal.source_url === "")) {
      errors.push(`${label}: deal source_url must be a non-empty string when present`);
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
