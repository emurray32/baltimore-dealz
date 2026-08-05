// Renders the "Tonight in <view>" board. Minimal styling on purpose —
// Designer owns the visual pass in a later ticket.

import { dayKeyInZone, dayLabel, dealsForDay, isRenderable, weekByDay } from "./deals.js";

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

function dealCard({ venue, deal }) {
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
  return `
      <article class="card">
        <h3>${escapeHtml(venue.name)} ${window}</h3>
        <ul>${items}</ul>
        ${noPrices}
        <p class="meta">${metaLines(venue, deal)}</p>
      </article>`;
}

function notesSection(venues) {
  const notes = venues
    .filter((venue) => isRenderable(venue) && venue.notes_public)
    .map(
      (venue) =>
        `<p class="meta"><strong>${escapeHtml(venue.name)}</strong> — ${escapeHtml(venue.notes_public)}</p>`,
    )
    .join("");
  return notes ? `<section><h2>Good to know</h2>${notes}</section>` : "";
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

// `venues` is already filtered to this view — see venuesForView in deals.js.
export function renderBoard(venues, view, views = [view], now = new Date()) {
  const todayKey = dayKeyInZone(now);
  const todayRows = dealsForDay(venues, todayKey);

  const today = todayRows.length
    ? todayRows.map(dealCard).join("")
    : `<p class="meta">Nothing on the list for ${escapeHtml(dayLabel(todayKey))} yet.</p>`;

  // Today stays collapsed here — it is already spelled out above.
  const week = weekByDay(venues)
    .map(
      (day) => `
      <details>
        <summary>${escapeHtml(day.label)}${day.key === todayKey ? " (tonight)" : ""}</summary>
        ${day.rows.length ? day.rows.map(dealCard).join("") : '<p class="meta">Nothing listed.</p>'}
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
    <section>
      <h2>On tonight</h2>
      ${today}
    </section>
    ${notesSection(venues)}
    <section>
      <h2>Browse the week</h2>
      ${week}
    </section>
  </main>
</body>
</html>
`;
}
