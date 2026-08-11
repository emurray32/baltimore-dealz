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

// Only "verified" venues can contribute deal cards. Everything else stays in
// venues.json (and on /venue pages) but is not listed on the board or map.
export const VERIFIED = "verified";

export function isRenderable(venue) {
  return venue.status === VERIFIED;
}

// City-wide marker: every venue, not a hand-written neighbourhood list.
// New neighbourhoods appear on the front page without updating this view.
export function isCityWideView(view) {
  return view?.neighborhoods === "*";
}

// Every venue in the view's neighborhoods, including those with nothing to show.
// City-wide ("*") returns the full list once (no per-neighbourhood duplication).
export function venuesInView(venues, view) {
  if (isCityWideView(view)) return venues;
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

// Zero-deal / held-only venues — kept in data and on /venue pages, omitted from
// the board and map (Eric rule 2026-08-07). Helper is for tests and callers that
// need the set; the board no longer renders a quiet-group section.
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

// Same filtering as dealsForDay but grouped by venue so each venue produces
// at most one row per day, with all of its showable deals in that row.
export function dealsGroupedForDay(venues, dayKey) {
  const groups = new Map();
  for (const venue of venues) {
    if (!isRenderable(venue)) continue;
    const deals = [];
    for (const deal of venue.deals) {
      if (!isDealRenderable(deal)) continue;
      if (deal.days.includes(dayKey)) {
        deals.push(deal);
      }
    }
    if (deals.length > 0) {
      groups.set(venue.id, { venue, deals });
    }
  }
  return [...groups.values()];
}

export function weekByDay(venues) {
  return WEEK.map((day) => ({ ...day, rows: dealsGroupedForDay(venues, day.key) }));
}

// Great-circle distance in meters between two lat/lon points (haversine,
// spherical Earth). Pure arithmetic so the test suite can pin it without a
// browser. The board's nearest-first sort and any server-side "how far is this
// spot" both read from this one function.
export const EARTH_RADIUS_M = 6371000;
export const METERS_PER_MILE = 1609.344;

export function distanceMeters(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// open_unverifiable = open, no deal we can publish.
// unconfirmed = neither open nor closed is supportable (e.g. Tap House: dead
// site/IG, but lead-level listings still look live). Still no deal cards.
export const STATUSES = [VERIFIED, "open_unverifiable", "unconfirmed"];

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
  // Optional: true when Deal Scout confirmed this row is a happy hour (not every
  // day special). verified_date is per-deal freshness, separate from venue
  // last_verified.
  "happy_hour",
  "verified_date",
  // Optional array of controlled food labels (Deal Scout §8f/§8g). Never
  // keyword-guessed — human-tagged. Multi-food rows carry multiple values.
  "food_categories",
  // Optional verbatim quote from the venue's own page (proof next to the
  // claim). Rendered as a blockquote on the card so the source link is a
  // backup, not the whole argument. Exact words only — never paraphrased.
  "proof_quote",
]);
const ITEM_KEYS = new Set(["text", "price"]);

// Controlled vocabulary for deal.food_categories. Order is display order.
// Source of truth: Deal Scout master research file §8e vocab + §8f array form.
export const FOOD_CATEGORIES = [
  "wings",
  "burger",
  "brunch",
  "sandwich/cheesesteak",
  "tacos",
  "sushi",
  "steak",
  "seafood/crab",
  "pizza",
  "fajitas",
  "pasta/comfort",
  "pretzel",
  "small-plate/apps",
  "sliders",
  "drink",
  "event",
];
const FOOD_CATEGORY_SET = new Set(FOOD_CATEGORIES);

// Short chip labels — same scannable style as the Happy Hour chip.
export const FOOD_CATEGORY_LABELS = {
  wings: "Wings",
  burger: "Burger",
  brunch: "Brunch",
  "sandwich/cheesesteak": "Sandwich",
  tacos: "Tacos",
  sushi: "Sushi",
  steak: "Steak",
  "seafood/crab": "Seafood",
  pizza: "Pizza",
  fajitas: "Fajitas",
  "pasta/comfort": "Pasta",
  pretzel: "Pretzel",
  "small-plate/apps": "Apps",
  sliders: "Sliders",
  drink: "Drink",
  event: "Event",
};

// A deal's verified_date older than this many whole days is stale on the board.
export const STALE_AFTER_DAYS = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True when verifiedDate (YYYY-MM-DD) is more than STALE_AFTER_DAYS before `now`.
// Calendar-day math in UTC so a machine clock in any zone agrees with the suite.
// Missing or malformed dates are not "stale" — validation rejects those separately.
export function isVerifiedDateStale(verifiedDate, now = new Date(), maxAgeDays = STALE_AFTER_DAYS) {
  if (typeof verifiedDate !== "string" || !DATE_RE.test(verifiedDate)) return false;
  const [y, m, d] = verifiedDate.split("-").map(Number);
  const verifiedUtc = Date.UTC(y, m - 1, d);
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = (nowUtc - verifiedUtc) / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

// A venue that publishes its deals in a form we cannot machine-read.
export const DEAL_FORMATS = ["image"];

// How many offer lines a board card shows before the rest collapse. Eric,
// 2026-08-10: a card listing all 18 happy-hour items reads as a menu, not as a
// set of deals. 36 of 51 venues were over this line.
export const CARD_OFFER_LIMIT = 6;

// A price the VENUE itself stated as a saving: "$3 off", "1/2 price", "BOGO",
// "2 for 1", "Free". These are the only lines a customer can judge without
// knowing the regular price, so they go to the top of every card.
//
// This reads the structured `price` field, never the item text. Prose matching
// is how "1/2 Lb. Peel & Eat Shrimp $16" once got promoted as half-price.
const STATED_SAVING_RE = /(off\b|\bprice\b|\bbogo\b|\bfor\b|\bfree\b)/i;

// Some saving lines carry no price field at all ("Free street taco with order
// of two", "Kids eat free after 5"). Those are among the clearest deals on the
// board, so they must not sink to the bottom with the trivia nights.
//
// This one runs against item TEXT, so it is deliberately narrower than the
// price-field test: whole phrases only, never a bare "off", "price" or "for".
// Every line it fires on is pinned by a test.
const TEXT_SAVING_RE =
  /(\bfree\b|\bb\.?o\.?g\.?o\.?\b|\d+\s*%\s*off\b|\$\s*\d+(?:\.\d+)?\s*off\b|\b(?:half|1\/2)\s+(?:off|price)\b)/i;

// Leading dollar amount. A range ("$8.50–$12") sorts on its low end — the
// cheapest way in is what makes the line worth showing.
const AMOUNT_RE = /\$\s*(\d+(?:\.\d+)?)/;

// Sort key for one offer: [tier, amount]. Lower sorts first.
// - tier 0: a stated saving, from the price field or an unmistakable phrase
// - tier 1: a plain price, cheapest first
// - tier 2: no readable price (event lines like "Trivia Night") — last
export function offerRank(item) {
  const price = typeof item?.price === "string" ? item.price : "";
  const text = typeof item?.text === "string" ? item.text : "";
  if (price) {
    if (STATED_SAVING_RE.test(price)) return [0, 0];
    const amount = AMOUNT_RE.exec(price);
    if (amount) return [1, Number(amount[1])];
  }
  // No usable price field — the item's own words can still prove a saving.
  // Deliberately NOT parsing an amount out of free text: "Bmore Trivia — win a
  // $50 gift card" is a prize, not a price. A line that needs a price gets a
  // price field in the data.
  if (TEXT_SAVING_RE.test(text)) return [0, 0];
  return [2, 0];
}

// Stated savings first, then cheapest first, then unpriced lines — stable
// within each tier so the venue's own ordering survives where we add nothing.
export function rankOffers(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => ({ item, index, rank: offerRank(item) }))
    .sort((a, b) => {
      if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0];
      if (a.rank[1] !== b.rank[1]) return a.rank[1] - b.rank[1];
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

// Above this, a price with no stated saving is just a menu item. Eric,
// 2026-08-10: "If it's $4 drafts, that's a deal, but simply naming things and
// giving prices isn't what we're going for." A $28 wing platter may well be
// good value, but nobody can tell from the number alone, so it does not lead
// the card. Lines carrying a stated saving are exempt at any price.
//
// This is a judgment call, not a measurement — one number, easy to move.
export const JUDGEABLE_MAX_PRICE = 12;

// Never leave a card with nothing on it. A venue whose every line is above the
// ceiling still shows its cheapest few rather than collapsing to a bare header.
export const CARD_OFFER_FLOOR = 3;

// True when a customer can tell this is a deal without knowing the regular
// price: the venue stated the saving, or the number is plainly cheap.
export function isJudgeableOffer(item, maxPrice = JUDGEABLE_MAX_PRICE) {
  const [tier, amount] = offerRank(item);
  if (tier === 0) return true;
  if (tier === 1) return amount <= maxPrice;
  return false;
}

// Split ranked offers into what a card shows and what collapses behind
// "+N more". Nothing is ever dropped — the rest ship in the same document so
// search, filters and JS-off readers still reach every line.
export function splitOffers(items, limit = CARD_OFFER_LIMIT) {
  const ranked = rankOffers(items);
  const judgeable = ranked.filter((item) => isJudgeableOffer(item));
  // Prefer the lines a customer can actually judge. If too few qualify, top up
  // from the front of the ranked list so a card is never bare.
  const head =
    judgeable.length >= CARD_OFFER_FLOOR
      ? judgeable.slice(0, limit)
      : ranked.slice(0, Math.min(CARD_OFFER_FLOOR, ranked.length));
  const shownSet = new Set(head);
  return { shown: head, rest: ranked.filter((item) => !shownSet.has(item)) };
}

// Minutes past midnight, or null. `end: null` MEANS the venue published no end
// time — so hasEnded can never be true for it. That is the whole point of the
// split: the canon stops being a rule someone remembers and becomes a shape.
export function hasEnded(deal, minutesNow) {
  if (deal.end === null || deal.end === undefined) return false;
  return minutesNow >= deal.end;
}

// Minutes past midnight *in Baltimore* (or another zone), not the machine clock.
// hourCycle h23 keeps midnight as 0 rather than 24.
export function minutesNowInZone(date = new Date(), timeZone = BALTIMORE_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

// Board timing bucket for a deal on its listed day. Used by the client to
// group tonight's cards; pure so tests can pin it without the DOM.
//
// - finished: published end is at or before now (end:null is NEVER finished)
// - starts_later: published start is still in the future
// - on_now: already started
// - hours_unlisted: the venue did not publish a start time — never invent a window
export function dealTiming(deal, minutesNow) {
  if (hasEnded(deal, minutesNow)) return "finished";
  if (deal.start === null || deal.start === undefined) return "hours_unlisted";
  if (minutesNow < deal.start) return "starts_later";
  return "on_now";
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
    if (deal.proof_quote !== undefined && (typeof deal.proof_quote !== "string" || deal.proof_quote === "")) {
      errors.push(`${label}: proof_quote must be a non-empty string when present`);
    }
    if (deal.status !== undefined && !DEAL_STATUSES.includes(deal.status)) {
      errors.push(
        `${label}: deal status must be omitted or one of ${DEAL_STATUSES.join(", ")}`,
      );
    }
    if (deal.happy_hour !== undefined && typeof deal.happy_hour !== "boolean") {
      errors.push(`${label}: happy_hour must be a boolean when present`);
    }
    if (deal.verified_date !== undefined) {
      if (typeof deal.verified_date !== "string" || !DATE_RE.test(deal.verified_date)) {
        errors.push(`${label}: verified_date must be YYYY-MM-DD when present`);
      }
    }
    if (deal.food_categories !== undefined) {
      if (!Array.isArray(deal.food_categories) || deal.food_categories.length === 0) {
        errors.push(`${label}: food_categories must be a non-empty array when present`);
      } else {
        const seen = new Set();
        for (const cat of deal.food_categories) {
          if (typeof cat !== "string" || !FOOD_CATEGORY_SET.has(cat)) {
            errors.push(
              `${label}: food_categories value "${cat}" must be one of ${FOOD_CATEGORIES.join(", ")}`,
            );
          } else if (seen.has(cat)) {
            errors.push(`${label}: food_categories has duplicate "${cat}"`);
          } else {
            seen.add(cat);
          }
        }
      }
    }
    // An unknown key here is almost always someone inventing their own way to
    // hold a row back. Silently ignoring it would render the deal anyway.
    for (const key of Object.keys(deal)) {
      if (!DEAL_KEYS.has(key)) errors.push(`${label}: unknown field "${key}" on a deal`);
    }
  }

  return errors;
}
