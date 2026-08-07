// Per-venue detail page: full weekly schedule + contact lines the deal card
// no longer carries. Pure string render like page.js / map.js.

import {
  FOOD_CATEGORY_LABELS,
  hasShowableDeal,
  isDealRenderable,
  isRenderable,
  isVerifiedDateStale,
  WEEK,
} from "./deals.js";
import { escapeHtml } from "./page.js";

// Which board "owns" this venue for the back-link — first *neighbourhood*
// view whose list includes it, else the default view. City-wide ("*") is
// skipped so the back link stays neighbourhood-local, not the city front page.
export function boardViewForVenue(venue, views, fallback) {
  const hit = views.find(
    (v) =>
      Array.isArray(v.neighborhoods) &&
      v.neighborhoods.includes(venue.neighborhood),
  );
  return hit ?? fallback ?? views[0];
}

// Deals this venue shows publicly, grouped Mon-first. Held rows never appear.
export function venueScheduleByDay(venue) {
  const showable = isRenderable(venue)
    ? venue.deals.filter(isDealRenderable)
    : [];
  return WEEK.map((day) => ({
    key: day.key,
    label: day.label,
    deals: showable.filter((d) => d.days.includes(day.key)),
  }));
}

function dealChips(deal, now) {
  const chips = [];
  if (deal.happy_hour === true) {
    chips.push('<span class="chip">Happy Hour</span>');
  }
  if (Array.isArray(deal.food_categories)) {
    for (const cat of deal.food_categories) {
      const label = FOOD_CATEGORY_LABELS[cat] ?? cat;
      chips.push(`<span class="chip">${escapeHtml(label)}</span>`);
    }
  }
  if (deal.verified_date) {
    const stale = isVerifiedDateStale(deal.verified_date, now);
    const label = stale
      ? `verified ${escapeHtml(deal.verified_date)} · stale`
      : `verified ${escapeHtml(deal.verified_date)}`;
    chips.push(
      `<span class="chip${stale ? " chip-stale" : ""}">${label}</span>`,
    );
  }
  return chips.length ? `<p class="chips">${chips.join(" ")}</p>` : "";
}

function scheduleDeal(deal, now) {
  const window = deal.time_window
    ? `<span class="window">${escapeHtml(deal.time_window)}</span>`
    : "";
  const items = deal.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("");
  const noPrices =
    deal.prices_published === false
      ? '<p class="meta">Prices not published by the venue.</p>'
      : "";
  const source = deal.source_url
    ? `<p class="meta"><a href="${escapeHtml(deal.source_url)}">source</a></p>`
    : "";
  return `
    <article class="card venue-deal">
      <h3>${window || "Special"}</h3>
      ${dealChips(deal, now)}
      <ul>${items}</ul>
      ${noPrices}
      ${source}
    </article>`;
}

/**
 * options:
 *   styleHref, boardHref, mapHref, listLabel
 */
export function renderVenuePage(venue, views, now = new Date(), options = {}) {
  const styleHref = options.styleHref ?? "/style.css";
  const boardHref = options.boardHref ?? "/";
  const listLabel = options.listLabel ?? "Back to board";
  const mapHref = options.mapHref ?? null;

  const placeBits = [venue.neighborhood, venue.address].filter(Boolean).map(escapeHtml);
  const provenance = [];
  if (venue.phone) {
    const dialable = venue.phone.replace(/[^0-9+]/g, "");
    provenance.push(
      `<a href="tel:${escapeHtml(dialable)}">${escapeHtml(venue.phone)}</a>`,
    );
  }
  if (venue.source_url) {
    provenance.push(
      `<a href="${escapeHtml(venue.source_url)}">source</a>`,
    );
  }
  if (venue.last_verified) {
    provenance.push(`last verified ${escapeHtml(venue.last_verified)}`);
  }

  const schedule = venueScheduleByDay(venue);
  const hasAnyDeal = schedule.some((d) => d.deals.length > 0);
  let scheduleHtml;
  if (!isRenderable(venue) || !hasShowableDeal(venue) || !hasAnyDeal) {
    const reason =
      venue.notes_public ||
      "No specials we can verify from an official source.";
    scheduleHtml = `
      <section class="venue-empty">
        <h2>This week</h2>
        <p class="meta">${escapeHtml(reason)}</p>
      </section>`;
  } else {
    const days = schedule
      .map((day) => {
        if (day.deals.length === 0) {
          return `
        <section class="venue-day" data-day="${escapeHtml(day.key)}">
          <h2>${escapeHtml(day.label)}</h2>
          <p class="meta">Nothing listed.</p>
        </section>`;
        }
        return `
        <section class="venue-day" data-day="${escapeHtml(day.key)}">
          <h2>${escapeHtml(day.label)}</h2>
          ${day.deals.map((d) => scheduleDeal(d, now)).join("")}
        </section>`;
      })
      .join("");
    scheduleHtml = `<section class="venue-week"><h2 class="sr-only">Weekly schedule</h2>${days}</section>`;
  }

  const mapLink = mapHref
    ? ` · <a href="${escapeHtml(mapHref)}">Map</a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(venue.name)} — Baltimore Dealz</title>
  <link rel="stylesheet" href="${escapeHtml(styleHref)}">
</head>
<body>
  <header>
    <p class="meta"><a href="${escapeHtml(boardHref)}">${escapeHtml(listLabel)}</a>${mapLink}</p>
    <h1>${escapeHtml(venue.name)}</h1>
    <p class="meta">${placeBits.join(" · ")}</p>
    ${provenance.length ? `<p class="meta">${provenance.join(" · ")}</p>` : ""}
  </header>
  <main>
    ${scheduleHtml}
  </main>
</body>
</html>
`;
}
