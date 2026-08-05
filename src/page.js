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
function metaLines(venue, deal = null) {
  const place = [venue.neighborhood, venue.address].filter(Boolean).map(escapeHtml);

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

  return [place.join(" · "), provenance.join(" · ")].filter(Boolean).join("<br>");
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

function dealCard({ venue, deal }, now = new Date()) {
  const window = deal.time_window
    ? `<span class="window">${escapeHtml(deal.time_window)}</span>`
    : "";
  const items = deal.items.map((item) => `<li>${escapeHtml(item.text)}</li>`).join("");
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
  return `
      <article class="card"${coords}>
        <h3>${escapeHtml(venue.name)} ${window}</h3>
        ${dealChips(deal, now)}
        <ul>${items}</ul>
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
function noDealSection(venues) {
  const quiet = noDealVenues(venues);
  if (quiet.length === 0) return "";

  const n = quiet.length;
  const label = n === 1 ? "1 more spot, no deals we can show" : `${n} more spots, no deals we can show`;
  const rows = quiet
    .map((venue) => {
      const reason = venue.notes_public || "No specials we can verify from an official source.";
      const where = venue.address
        ? `${escapeHtml(venue.address)} — ${escapeHtml(reason)}`
        : escapeHtml(reason);
      return `<li><strong>${escapeHtml(venue.name)}</strong><br><span class="meta">${where}</span></li>`;
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
function viewSwitcher(views, currentView) {
  if (views.length < 2) return "";
  const links = views
    .map((view) =>
      view.slug === currentView.slug
        ? `<strong>${escapeHtml(view.label)}</strong>`
        : `<a href="/${escapeHtml(view.slug)}">${escapeHtml(view.label)}</a>`,
    )
    .join(" · ");
  return `<nav class="meta">${links}</nav>`;
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
        var cards = Array.prototype.slice.call(board.querySelectorAll("[data-lat]"));
        cards.forEach(function (card) {
          var m = meters(lat, lon, parseFloat(card.dataset.lat), parseFloat(card.dataset.lon));
          var span = document.createElement("span");
          span.className = "distance";
          span.textContent = (m / MI).toFixed(1) + " mi";
          card.querySelector("h3").appendChild(span);
          card._d = m;
        });
        cards.sort(function (a, b) { return a._d - b._d; });
        cards.forEach(function (card) { board.appendChild(card); });
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
export function renderBoard(venues, view, views = [view], now = new Date()) {
  const todayKey = dayKeyInZone(now);
  const todayRows = dealsForDay(venues, todayKey);

  const card = (row) => dealCard(row, now);

  const today = todayRows.length
    ? todayRows.map(card).join("")
    : `<p class="meta">Nothing on the list for ${escapeHtml(dayLabel(todayKey))} yet.</p>`;

  // Today stays collapsed here — it is already spelled out above.
  const week = weekByDay(venues)
    .map(
      (day) => `
      <details>
        <summary>${escapeHtml(day.label)}${day.key === todayKey ? " (tonight)" : ""}</summary>
        ${day.rows.length ? day.rows.map(card).join("") : '<p class="meta">Nothing listed.</p>'}
      </details>`,
    )
    .join("");

  const title = `Tonight in ${view.label}`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Baltimore Dealz</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${escapeHtml(dayLabel(todayKey))} · Baltimore time</p>
    ${viewSwitcher(views, view)}
  </header>
  <main>
    <section id="tonight-board">
      <h2>On tonight</h2>
      <p class="nearest-row"><button type="button" id="nearest-btn" hidden>Closest to me</button></p>
      ${today}
    </section>
    ${notesSection(venues)}
    <section>
      <h2>Browse the week</h2>
      ${week}
    </section>
    ${noDealSection(venues)}
  </main>
  ${NEAREST_FIRST_SCRIPT}
</body>
</html>
`;
}
