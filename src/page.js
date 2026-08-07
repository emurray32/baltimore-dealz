// Renders the "Tonight in <view>" board. Minimal styling on purpose —
// Designer owns the visual pass in a later ticket.

import {
  dayKeyInZone,
  dayLabel,
  dealsForDay,
  EARTH_RADIUS_M,
  FOOD_CATEGORY_LABELS,
  hasShowableDeal,
  isVerifiedDateStale,
  METERS_PER_MILE,
  noDealVenues,
  WEEK,
  weekByDay,
} from "./deals.js";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Every meta line is built from the fields a venue actually has. A venue with
// no phone loses the phone link; it does not take the board down with it.
// Prefer the deal's own verification URL over the venue homepage — Mama's brunch
// was verified on Instagram, not the website the card used to link to.
// Card meta only — neighbourhood + phone/source/verified. Street address lives
// on the venue page (and still on the quiet group, where it is load-bearing).
function metaLines(venue, deal = null) {
  const place = venue.neighborhood ? escapeHtml(venue.neighborhood) : "";

  const provenance = [];
  if (venue.phone) {
    const dialable = venue.phone.replace(/[^0-9+]/g, "");
    provenance.push(`<a href="tel:${escapeHtml(dialable)}">${escapeHtml(venue.phone)}</a>`);
  }
  const sourceUrl = deal?.source_url || venue.source_url;
  if (sourceUrl) {
    provenance.push(`<a href="${escapeHtml(sourceUrl)}">source</a>`);
  }
  if (venue.last_verified) {
    provenance.push(`last verified ${escapeHtml(venue.last_verified)}`);
  }

  return [place, provenance.join(" · ")].filter(Boolean).join("<br>");
}

// Happy Hour + food-category + per-deal verified date chips. Venue last_verified
// stays in meta as the fallback provenance line — these are deal-level only.
// Multi-category rows render one chip per category (Claddagh Sat/Wed).
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

function dealCard({ venue, deal }, now = new Date(), options = {}) {
  const window = deal.time_window
    ? `<span class="window">${escapeHtml(deal.time_window)}</span>`
    : "";
  const items = deal.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("");
  // Proof next to the claim: the venue's own words, verbatim, so the source
  // link is a backup rather than the whole argument.
  const proof = deal.proof_quote
    ? `<blockquote class="proof">${escapeHtml(deal.proof_quote)}</blockquote>`
    : "";
  // A venue that published times but no prices says so, rather than looking
  // like a deal we forgot to fill in.
  const noPrices =
    deal.prices_published === false
      ? '<p class="meta">Prices not published by the venue.</p>'
      : "";
  // Coordinates ride the card as data attributes. The nearest-first script reads
  // them only after the customer shares a location; until then they are inert
  // markup and the board keeps its published order. A venue with no coordinates
  // (Sports Balls) simply carries no attributes and stays in that order.
  const coords =
    typeof venue.lat === "number" && typeof venue.lon === "number"
      ? ` data-lat="${venue.lat}" data-lon="${venue.lon}"`
      : "";
  // Start/end minutes for client-side on-now / starts-later / finished grouping.
  // Empty string means null/untimed — never invent a window on the client.
  const startAttr =
    deal.start === null || deal.start === undefined ? "" : String(deal.start);
  const endAttr =
    deal.end === null || deal.end === undefined ? "" : String(deal.end);
  // Food-filter hook: multi-category rows appear under every one of theirs
  // (Claddagh Sat → Wings AND Sandwiches).
  const food =
    Array.isArray(deal.food_categories) && deal.food_categories.length
      ? ` data-food="${escapeHtml(deal.food_categories.join(" "))}"`
      : "";
  const venueHref =
    typeof options.venueHref === "function"
      ? options.venueHref(venue.id)
      : `/venue/${venue.id}`;
  const nameHtml = `<a class="venue-link" href="${escapeHtml(venueHref)}">${escapeHtml(venue.name)}</a>`;
  return `
      <article class="card"${coords}${food} data-start="${escapeHtml(startAttr)}" data-end="${escapeHtml(endAttr)}">
        <h3>${nameHtml} ${window}</h3>
        ${dealChips(deal, now)}
        <ul>${items}</ul>
        ${proof}
        ${noPrices}
        <p class="meta">${metaLines(venue, deal)}</p>
      </article>`;
}

// Notes on venues that still have deals on the board — not the no-deal group.
function notesSection(venues) {
  const notes = venues
    .filter((venue) => hasShowableDeal(venue) && venue.notes_public)
    .map(
      (venue) =>
        `<p class="meta"><strong>${escapeHtml(venue.name)}</strong> — ${escapeHtml(venue.notes_public)}</p>`,
    )
    .join("");
  return notes ? `<section><h2>Good to know</h2>${notes}</section>` : "";
}

// Designer's collapsed group: name + address + reason, never a deal/hour/price.
// open_unverifiable rows and fully-held venues (El Bufalo) both land here.
// Address stays here — these rows have no deal body; the street is the content.
function noDealSection(venues, options = {}) {
  const quiet = noDealVenues(venues);
  if (quiet.length === 0) return "";

  const n = quiet.length;
  const label = n === 1 ? "1 more spot, no deals we can show" : `${n} more spots, no deals we can show`;
  const venueHref =
    typeof options.venueHref === "function"
      ? options.venueHref
      : (id) => `/venue/${id}`;
  const rows = quiet
    .map((venue) => {
      const reason = venue.notes_public || "No specials we can verify from an official source.";
      const where = venue.address
        ? `${escapeHtml(venue.address)} — ${escapeHtml(reason)}`
        : escapeHtml(reason);
      const name = `<a class="venue-link" href="${escapeHtml(venueHref(venue.id))}">${escapeHtml(venue.name)}</a>`;
      return `<li><strong>${name}</strong><br><span class="meta">${where}</span></li>`;
    })
    .join("");

  return `
    <section class="quiet">
      <details>
        <summary>${escapeHtml(label)}</summary>
        <ul class="quiet-list">${rows}</ul>
      </details>
    </section>`;
}

// Only worth showing once there is somewhere else to go.
// linkFor(slug) builds the href so the static build can emit relative paths
// without forking the switcher markup.
function viewSwitcher(views, currentView, linkFor = (slug) => `/${slug}`) {
  if (views.length < 2) return "";
  const links = views
    .map((view) =>
      view.slug === currentView.slug
        ? `<strong>${escapeHtml(view.label)}</strong>`
        : `<a href="${escapeHtml(linkFor(view.slug))}">${escapeHtml(view.label)}</a>`,
    )
    .join(" · ");
  return `<nav class="meta">${links}</nav>`;
}

// Cards (or the empty-state line) for one day — same markup renderBoard uses.
// Exported so the static build can embed one <template> per weekday.
export function cardsHtmlForDay(venues, dayKey, now = new Date(), options = {}) {
  const rows = dealsForDay(venues, dayKey);
  if (!rows.length) {
    return `<p class="meta">Nothing on the list for ${escapeHtml(dayLabel(dayKey))} yet.</p>`;
  }
  return rows.map((row) => dealCard(row, now, options)).join("");
}

// One button per food category that appears on the board this week, with the
// real count of matching deal rows. Categories with zero rows get no button.
// Multi-category rows count under every category they carry.
export function foodFilterBar(venues) {
  const counts = new Map();
  for (const day of WEEK) {
    for (const { deal } of dealsForDay(venues, day.key)) {
      if (!Array.isArray(deal.food_categories)) continue;
      for (const cat of deal.food_categories) {
        counts.set(cat, (counts.get(cat) ?? 0) + 1);
      }
    }
  }
  if (counts.size === 0) return "";
  const buttons = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cat, n]) => {
      const label = FOOD_CATEGORY_LABELS[cat] ?? cat;
      return `<button type="button" class="filter-btn" data-filter="${escapeHtml(cat)}" aria-pressed="false">${escapeHtml(label)} <span class="filter-count">${n}</span></button>`;
    })
    .join("");
  return `
    <section class="food-filter" id="food-filter" aria-label="Filter deals by food">
      <h2>Filter by food</h2>
      <p class="filter-row" role="group">
        <button type="button" class="filter-btn is-on" data-filter="" aria-pressed="true">All</button>
        ${buttons}
      </p>
      <p class="filter-status meta" id="filter-status" role="status" aria-live="polite"></p>
    </section>`;
}

// The browser-side half of nearest-first, served inline at the end of
// renderBoard's output (the page ships no modules, so it is interpolated as a
// string). Everything the script needs is baked in server-side; nothing
// user-controlled reaches it, and the client mirrors the server's
// distanceMeters rather than importing it.
export const NEAREST_FIRST_SCRIPT = `<script>
(function () {
  var btn = document.getElementById("nearest-btn");
  var board = document.getElementById("tonight-board");
  if (!btn || !board) return;
  // Geolocation is opt-in and not universal. Where it is missing entirely the
  // button is dead weight, so it stays hidden (its default) and we stop there.
  if (!("geolocation" in navigator)) {
    btn.hidden = true;
    return;
  }
  // Geolocation exists, so the button can work — reveal it. It stays opt-in:
  // no location is requested until the customer taps.
  btn.hidden = false;
  var R = ${EARTH_RADIUS_M};
  function meters(aLat, aLon, bLat, bLon) {
    var rad = Math.PI / 180;
    var dLat = (bLat - aLat) * rad;
    var dLon = (bLon - aLon) * rad;
    var h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(aLat * rad) * Math.cos(bLat * rad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  var MI = ${METERS_PER_MILE};
  btn.addEventListener("click", function () {
    btn.disabled = true;
    btn.textContent = "Finding you…";
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        var lat = pos.coords.latitude;
        var lon = pos.coords.longitude;
        // Sort within each timing group (or the board itself if ungrouped).
        var hosts = board.querySelectorAll(".timing-cards");
        if (hosts.length === 0) hosts = [board];
        for (var h = 0; h < hosts.length; h++) {
          var host = hosts[h];
          var cards = Array.prototype.slice.call(host.querySelectorAll(":scope > [data-lat]"));
          cards.forEach(function (card) {
            var m = meters(lat, lon, parseFloat(card.dataset.lat), parseFloat(card.dataset.lon));
            if (!card.querySelector("h3 .distance")) {
              var span = document.createElement("span");
              span.className = "distance";
              span.textContent = (m / MI).toFixed(1) + " mi";
              card.querySelector("h3").appendChild(span);
            }
            card._d = m;
          });
          cards.sort(function (a, b) { return a._d - b._d; });
          cards.forEach(function (card) { host.appendChild(card); });
        }
        btn.textContent = "Sorted nearest first";
      },
      function () {
        // Denied or unavailable — the published order stays, and the button
        // says so rather than silently doing nothing.
        btn.disabled = false;
        btn.textContent = "Location unavailable";
      },
      { timeout: 10000, maximumAge: 300000 }
    );
  });
})();
</` + `script>`;

// `venues` is every venue in this view's neighborhoods (see venuesInView).
// Deal cards still only come from verified rows with showable deals.
//
// options (all optional, server leaves them off):
//   styleHref      — stylesheet href (default "/style.css")
//   mapHref        — "Map view" link (default "/<slug>/map")
//   calendarHref   — happy-hour .ics subscribe link (default "/<slug>/calendar.ics")
//   viewHref(slug) — switcher link builder (default "/<slug>")
//   staticClient   — per-day templates + client scripts (no raw venues JSON)
//   clientDaySrc    — script src for client-day.js
//   clientBoardSrc  — script src for client-board.js
//   clientSearchSrc — script src for client-search.js
//   venueHref(id)   — per-venue page link (default "/venue/<id>")
export function renderBoard(venues, view, views = [view], now = new Date(), options = {}) {
  const todayKey = dayKeyInZone(now);
  const venueHref =
    typeof options.venueHref === "function"
      ? options.venueHref
      : (id) => `/venue/${id}`;
  const cardOpts = { venueHref };
  const today = cardsHtmlForDay(venues, todayKey, now, cardOpts);
  const staticClient = options.staticClient === true;

  const card = (row) => dealCard(row, now, cardOpts);

  // Today stays collapsed here — it is already spelled out above.
  // data-day is static-only: the client retargets "(tonight)" without parsing
  // English day names. Live server HTML stays free of the attribute.
  const week = weekByDay(venues)
    .map((day) => {
      const dayAttr = staticClient ? ` data-day="${escapeHtml(day.key)}"` : "";
      return `
      <details${dayAttr}>
        <summary>${escapeHtml(day.label)}${day.key === todayKey ? " (tonight)" : ""}</summary>
        ${day.rows.length ? day.rows.map(card).join("") : '<p class="meta">Nothing listed.</p>'}
      </details>`;
    })
    .join("");

  const title = `Tonight in ${view.label}`;
  const styleHref = options.styleHref ?? "/style.css";
  const mapHref = options.mapHref ?? `/${view.slug}/map`;
  const calendarHref = options.calendarHref ?? `/${view.slug}/calendar.ics`;
  const viewHref = options.viewHref ?? ((slug) => `/${slug}`);

  // Client scripts always load: day accuracy + on-now / starts-later / finished
  // grouping from the browser clock. Static Pages build also embeds one
  // <template> per weekday so the browser can swap "On tonight" without the
  // raw venues file (ops_notes / held rows must never ship in the public HTML).
  const daySrc = options.clientDaySrc ?? "/client-day.js";
  const boardSrc = options.clientBoardSrc ?? "/client-board.js";
  const searchSrc = options.clientSearchSrc ?? "/client-search.js";
  const filterSrc = options.clientFilterSrc ?? "/client-filter.js";
  let dayTemplates = "";
  if (staticClient) {
    dayTemplates = WEEK.map(
      (day) =>
        `<template id="bd-day-${day.key}">${cardsHtmlForDay(venues, day.key, now, cardOpts)}</template>`,
    ).join("\n");
  }
  const clientBits = `
  <noscript><p class="meta">JavaScript is off — "tonight" is frozen at the last build's day (and is not split by time of day). Turn JS on for Baltimore-time accuracy, search, filters, or use Browse the week.</p></noscript>
  ${dayTemplates}
  <script src="${escapeHtml(daySrc)}"></script>
  <script src="${escapeHtml(boardSrc)}"></script>
  <script src="${escapeHtml(searchSrc)}"></script>
  <script src="${escapeHtml(filterSrc)}"></script>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Baltimore Dealz</title>
  <link rel="stylesheet" href="${escapeHtml(styleHref)}">
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${escapeHtml(dayLabel(todayKey))}</p>
    ${viewSwitcher(views, view, viewHref)}
    <p class="meta map-link"><a href="${escapeHtml(mapHref)}">Map view</a> · <a href="${escapeHtml(calendarHref)}">Add happy hours to calendar</a></p>
  </header>
  <main>
    <section id="tonight-board">
      <h2>On tonight</h2>
      <p class="nearest-row"><button type="button" id="nearest-btn" hidden>Closest to me</button></p>
      ${today}
    </section>
    ${notesSection(venues)}
    ${foodFilterBar(venues)}
    <section>
      <h2>Browse the week</h2>
      ${week}
    </section>
    ${noDealSection(venues, cardOpts)}
  </main>
  ${NEAREST_FIRST_SCRIPT}
  ${clientBits}
</body>
</html>
`;
}
