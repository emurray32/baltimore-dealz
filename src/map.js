// Renders the interactive map page for a view: one marker per tracked venue
// with coordinates, popup in the mockup shape (name, address, hours, the deal
// itself with prices, "last verified <date>" when the data carries one).
// Pure string rendering like page.js so the suite can pin it without a browser.

import { escapeHtml } from "./page.js";
import {
  FOOD_CATEGORY_LABELS,
  hasShowableDeal,
  isDealRenderable,
  isRenderable,
  isVerifiedDateStale,
} from "./deals.js";

// The payload the browser script reads. Built server-side from the same
// loadVenues() read the board uses, so the map re-reads the data fresh on
// every load — no caching layer of our own.
export function mapPayload(venues) {
  return venues
    .filter((venue) => typeof venue.lat === "number" && typeof venue.lon === "number")
    .map((venue) => {
      const deals = isRenderable(venue)
        ? venue.deals.filter(isDealRenderable).map((deal) => ({
            time_window: deal.time_window ?? null,
            prices_published: deal.prices_published !== false,
            days: deal.days,
            items: deal.items.map((item) => ({ text: item.text, price: item.price ?? null })),
            source_url: deal.source_url ?? null,
            happy_hour: deal.happy_hour === true,
            food_categories: Array.isArray(deal.food_categories) ? deal.food_categories : [],
            verified_date: deal.verified_date ?? null,
          }))
        : [];
      return {
        id: venue.id,
        name: venue.name,
        address: venue.address ?? null,
        neighborhood: venue.neighborhood,
        phone: venue.phone ?? null,
        lat: venue.lat,
        lon: venue.lon,
        showable: hasShowableDeal(venue),
        reason: venue.notes_public ?? null,
        last_verified: venue.last_verified ?? null,
        source_url: venue.source_url ?? null,
        deals,
      };
    });
}

// A venue with no coordinates (Sports Balls today) is tracked but unmappable.
// The page says so in plain words rather than silently dropping it.
export function unmappableNames(venues) {
  return venues
    .filter((venue) => typeof venue.lat !== "number" || typeof venue.lon !== "number")
    .map((venue) => venue.name);
}

// Popup HTML for one venue. Rendered server-side per venue (not in the
// browser) so the exact markup is pinned by the test suite — the browser just
// swaps it into the opened popup. Kept small: a popup is read standing on a
// sidewalk, not studied. Structure: header (name + address), a scrollable
// deals region, and a footer that NEVER scrolls — the verified date and
// source link stay visible even on the deepest deal list.
// Chips above a deal block — same markup and styles as the board's dealChips:
// Happy Hour, one per food category, then the per-deal verified date (with the
// 30-day stale flag). Optional fields; absent means no chip, never a gap.
function popupChips(deal, now) {
  const chips = [];
  if (deal.happy_hour === true) {
    chips.push('<span class="chip">Happy Hour</span>');
  }
  for (const cat of deal.food_categories) {
    const label = FOOD_CATEGORY_LABELS[cat] ?? cat;
    chips.push(`<span class="chip">${escapeHtml(label)}</span>`);
  }
  if (deal.verified_date) {
    const stale = isVerifiedDateStale(deal.verified_date, now);
    const label = stale
      ? `verified ${escapeHtml(deal.verified_date)} · stale`
      : `verified ${escapeHtml(deal.verified_date)}`;
    chips.push(`<span class="chip${stale ? " chip-stale" : ""}">${label}</span>`);
  }
  return chips.length ? `<p class="chips">${chips.join(" ")}</p>` : "";
}

export function popupHtml(entry, now = new Date()) {
  const head = [`<h3 class="pop-name">${escapeHtml(entry.name)}</h3>`];
  if (entry.address) {
    head.push(`<p class="pop-addr">${escapeHtml(entry.address)}</p>`);
  }

  let body = "";
  if (entry.deals.length > 0) {
    // Happy hour leads — that is the question the map exists to answer. Board
    // order is preserved within each group (stable sort).
    const ordered = [...entry.deals].sort(
      (a, b) => Number(b.happy_hour === true) - Number(a.happy_hour === true),
    );
    const dealBlocks = ordered
      .map((deal) => {
        const window = deal.time_window
          ? `<span class="window">${escapeHtml(deal.time_window)}</span>`
          : "";
        const items = deal.items
          .map((item) => `<li>${escapeHtml(item.text)}</li>`)
          .join("");
        const noPrices =
          deal.prices_published === false
            ? '<p class="pop-noprice">Prices not published by the venue.</p>'
            : "";
        return `<div class="pop-deal">${popupChips(deal, now)}${window}<ul>${items}</ul>${noPrices}</div>`;
      })
      .join("");
    body = `<div class="pop-scroll">${dealBlocks}</div>`;
  } else {
    const reason = entry.reason || "No specials we can verify from an official source.";
    body = `<div class="pop-scroll"><p class="pop-noprice">${escapeHtml(reason)}</p></div>`;
  }

  const meta = [];
  if (entry.phone) {
    const dialable = entry.phone.replace(/[^0-9+]/g, "");
    meta.push(`<a href="tel:${escapeHtml(dialable)}">${escapeHtml(entry.phone)}</a>`);
  }
  if (entry.source_url) {
    meta.push(`<a href="${escapeHtml(entry.source_url)}">source</a>`);
  }
  // "last verified <date>" renders only when the field exists — the map does
  // not wait on the per-deal verified_date data pass.
  if (entry.last_verified) {
    meta.push(`last verified ${escapeHtml(entry.last_verified)}`);
  }
  const foot =
    meta.length > 0 ? `<p class="pop-meta">${meta.join(" · ")}</p>` : "";

  return `<div class="pop">${head.join("")}${body}${foot}</div>`;
}

// Center the map on the venues it actually shows, not a hard-coded point.
export function mapCenter(payload) {
  if (payload.length === 0) return null;
  const lat = payload.reduce((sum, v) => sum + v.lat, 0) / payload.length;
  const lon = payload.reduce((sum, v) => sum + v.lon, 0) / payload.length;
  return [Number(lat.toFixed(6)), Number(lon.toFixed(6))];
}

// The browser script. Interpolated as a string like NEAREST_FIRST_SCRIPT —
// the page ships no modules. Everything it needs is baked into POPUPS and
// POINTS server-side; nothing user-controlled reaches it.
const MAP_SCRIPT = `<script src="/vendor/leaflet.js"></` + `script>
<script>
(function () {
  var points = window.BD_MAP_POINTS || [];
  var popups = window.BD_MAP_POPUPS || {};
  var center = window.BD_MAP_CENTER;
  if (!center || points.length === 0) return;
  var map = L.map("map", { scrollWheelZoom: false }).setView(center, 15);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  // One marker per venue. Showable deals get the filled pin; venues with
  // nothing we can show get the hollow one — never color alone, the hollow
  // ring reads as its own shape.
  points.forEach(function (p) {
    var icon = L.divIcon({
      className: "bd-pin" + (p.showable ? "" : " bd-pin-quiet"),
      html: '<span class="bd-pin-dot"></span>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    L.marker([p.lat, p.lon], { icon: icon, title: p.name })
      .addTo(map)
      .bindPopup(popups[p.id] || "", { maxWidth: 300, autoPanPadding: [24, 24] });
  });
})();
</` + `script>`;

// options (all optional, server leaves them off):
//   styleHref, leafletCssHref, leafletJsHref, listHref
//   mapHref(slug) — switcher link builder for other maps
export function renderMap(venues, view, views = [view], now = new Date(), options = {}) {
  const payload = mapPayload(venues);
  const center = mapCenter(payload);
  const popups = Object.fromEntries(payload.map((entry) => [entry.id, popupHtml(entry, now)]));
  const missing = unmappableNames(venues);

  // JSON baked into the page. "</" is escaped so a name like "</script>"
  // could never break out of the script block — the escape is invisible to
  // JSON.parse.
  const safeJson = (value) => JSON.stringify(value).replaceAll("</", "<\\/");

  const missingNote =
    missing.length > 0
      ? `<p class="meta">Not on the map — no verified location: ${missing.map(escapeHtml).join(", ")}.</p>`
      : "";

  const mapHref = options.mapHref ?? ((slug) => `/${slug}/map`);
  const switcher =
    views.length > 1
      ? `<nav class="meta">${views
          .map((v) =>
            v.slug === view.slug
              ? `<strong>${escapeHtml(v.label)}</strong>`
              : `<a href="${escapeHtml(mapHref(v.slug))}">${escapeHtml(v.label)}</a>`,
          )
          .join(" · ")}</nav>`
      : "";

  const title = `${view.label} map`;
  const styleHref = options.styleHref ?? "/style.css";
  const leafletCssHref = options.leafletCssHref ?? "/vendor/leaflet.css";
  const listHref = options.listHref ?? `/${view.slug}`;

  // MAP_SCRIPT hard-codes /vendor/leaflet.js — swap when the static build
  // needs a relative path two levels up from /<view>/map/.
  const mapScript = options.leafletJsHref
    ? MAP_SCRIPT.replace('src="/vendor/leaflet.js"', `src="${options.leafletJsHref}"`)
    : MAP_SCRIPT;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Baltimore Dealz</title>
  <link rel="stylesheet" href="${escapeHtml(leafletCssHref)}">
  <link rel="stylesheet" href="${escapeHtml(styleHref)}">
</head>
<body class="map-page">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">Tap a pin for the deal, hours, and when we last checked. <a href="${escapeHtml(listHref)}">List view</a></p>
    ${switcher}
  </header>
  <main>
    <div id="map" role="region" aria-label="Map of tracked venues in ${escapeHtml(view.label)}"></div>
    <p class="meta map-legend"><span class="lg lg-deal"></span> has deals we can show &nbsp;·&nbsp; <span class="lg lg-quiet"></span> tracked, nothing showable yet</p>
    ${missingNote}
    <p class="meta map-credit">Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors. Free tiles, no account, no key.</p>
  </main>
  <script>window.BD_MAP_POINTS = ${safeJson(payload)};</script>
  <script>window.BD_MAP_POPUPS = ${safeJson(popups)};</script>
  <script>window.BD_MAP_CENTER = ${safeJson(center)};</script>
  ${mapScript}
</body>
</html>
`;
}
