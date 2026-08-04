// Renders the "Tonight in Canton" board. Minimal styling on purpose —
// Designer owns the visual pass in a later ticket.

import { dayKeyInZone, dayLabel, dealsForDay, weekByDay } from "./deals.js";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function dealCard({ venue, deal }) {
  const window = deal.time_window
    ? `<span class="window">${escapeHtml(deal.time_window)}</span>`
    : "";
  const items = deal.items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `
      <article class="card">
        <h3>${escapeHtml(venue.name)} ${window}</h3>
        <ul>${items}</ul>
        <p class="meta">${escapeHtml(venue.neighborhood)} · ${escapeHtml(venue.address)}<br>
          <a href="tel:${escapeHtml(venue.phone.replace(/[^0-9+]/g, ""))}">${escapeHtml(venue.phone)}</a>
          · <a href="${escapeHtml(venue.source_url)}">source</a>
          · last verified ${escapeHtml(venue.last_verified)}</p>
      </article>`;
}

function notesSection(venues) {
  const notes = venues
    .filter((venue) => venue.notes)
    .map(
      (venue) =>
        `<p class="meta"><strong>${escapeHtml(venue.name)}</strong> — ${escapeHtml(venue.notes)}</p>`,
    )
    .join("");
  return notes ? `<section><h2>Good to know</h2>${notes}</section>` : "";
}

export function renderBoard(venues, now = new Date()) {
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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tonight in Canton — Baltimore Dealz</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <h1>Tonight in Canton</h1>
    <p class="meta">${escapeHtml(dayLabel(todayKey))} · Baltimore time</p>
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
