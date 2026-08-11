// The calendar page: a month grid, plus a day-by-day list underneath.
//
// Eric asked for "December 5th — XYZ, but also a monthly view". The grid is the
// month at a glance; the list below it is the readable form, one dated heading
// per day that actually has something on it. Both read from the same two feeds.

import { WEEK, dayLabel, dealsGroupedForDay, isDealRenderable } from "./deals.js";
import { addMonths, eventsOnDate, monthGrid, monthLabel, todayIso } from "./events.js";
import { escapeHtml } from "./page.js";

function dealText(deal) {
  return deal.items
    .map((item) => (item.price ? `${item.text} ${item.price}` : item.text))
    .join(" · ");
}

// Everything happening on one calendar cell, from both feeds, kept apart.
export function dayContents(venues, events, cell) {
  const dealRows = dealsGroupedForDay(venues, cell.dayKey, cell.date).map((row) => ({
    venue: row.venue,
    deals: row.deals.filter(isDealRenderable),
  }));
  return { deals: dealRows, events: eventsOnDate(events, cell.iso) };
}

function formatTime(time) {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, "0")}${suffix}`;
}

function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function gridCell(venues, events, cell, todayIsoDate, options) {
  if (!cell.inMonth) return `<td class="cal-cell cal-out" aria-hidden="true"></td>`;

  const { deals, events: dayEvents } = dayContents(venues, events, cell);
  const dealCount = deals.reduce((n, row) => n + row.deals.length, 0);
  const isToday = cell.iso === todayIsoDate;

  const chips = [];
  if (dealCount) chips.push(`<span class="cal-chip cal-chip-deal">${dealCount} deal${dealCount === 1 ? "" : "s"}</span>`);
  for (const ev of dayEvents.slice(0, 2)) {
    chips.push(`<span class="cal-chip cal-chip-event">${escapeHtml(ev.title)}</span>`);
  }
  if (dayEvents.length > 2) {
    chips.push(`<span class="cal-chip cal-chip-more">+${dayEvents.length - 2} more</span>`);
  }

  const anchor = dealCount || dayEvents.length
    ? `<a href="#day-${escapeHtml(cell.iso)}">${cell.day}</a>`
    : String(cell.day);

  return `<td class="cal-cell${isToday ? " cal-today" : ""}">
        <span class="cal-daynum">${anchor}</span>
        ${chips.join("")}
      </td>`;
}

function dayEntry(venues, events, cell, todayIsoDate, options) {
  const { deals, events: dayEvents } = dayContents(venues, events, cell);
  if (!deals.length && !dayEvents.length) return "";

  const venueHref = options.venueHref ?? ((id) => `/venue/${id}`);

  const eventList = dayEvents.length
    ? `<ul class="cal-events">${dayEvents
        .map(
          (ev) =>
            `<li><strong>${escapeHtml(ev.title)}</strong>${ev.time ? ` — ${escapeHtml(formatTime(ev.time))}` : ""}${
              ev.place ? ` · ${escapeHtml(ev.place)}` : ""
            } <a class="cal-src" href="${escapeHtml(ev.source_url)}" rel="nofollow noopener">source</a></li>`,
        )
        .join("")}</ul>`
    : "";

  const dealList = deals.length
    ? `<ul class="cal-deals">${deals
        .map(
          (row) =>
            `<li><a href="${escapeHtml(venueHref(row.venue.id))}">${escapeHtml(row.venue.name)}</a> — ${escapeHtml(
              row.deals.map(dealText).join(" · "),
            )}</li>`,
        )
        .join("")}</ul>`
    : "";

  const isToday = cell.iso === todayIsoDate;
  return `<section class="cal-day${isToday ? " cal-today" : ""}" id="day-${escapeHtml(cell.iso)}">
      <h3>${escapeHtml(longDate(cell.iso))}${isToday ? " <span class=\"cal-chip\">today</span>" : ""}</h3>
      ${eventList}
      ${dealList}
    </section>`;
}

// `month` is 1-based. Callers pass the month they want; the page links to the
// neighbours so a visitor can page through without typing a URL.
export function renderCalendar(venues, events, view, views, { year, month }, now = new Date(), options = {}) {
  const cells = monthGrid(year, month);
  const today = todayIso(now);
  const calHref = options.calendarHref ?? ((slug, y, m) => `/${slug}/calendar?month=${y}-${String(m).padStart(2, "0")}`);
  const boardHref = options.boardHref ?? `/${view.slug}`;

  const prev = addMonths(year, month, -1);
  const next = addMonths(year, month, 1);

  // A static host pre-renders a bounded window of months, so calHref may return
  // null for a neighbour outside it. Render that as plain text rather than a
  // link to a page that does not exist.
  const monthNav = (when, label) => {
    const href = calHref(view.slug, when.year, when.month);
    return href
      ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      : `<span class="cal-nav-off">${escapeHtml(label)}</span>`;
  };

  const rows = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(
      `<tr>${cells
        .slice(i, i + 7)
        .map((cell) => gridCell(venues, events, cell, today, options))
        .join("")}</tr>`,
    );
  }

  const entries = cells
    .filter((cell) => cell.inMonth)
    .map((cell) => dayEntry(venues, events, cell, today, options))
    .filter(Boolean)
    .join("");

  const head = WEEK.map((d) => `<th scope="col"><abbr title="${escapeHtml(d.label)}">${escapeHtml(d.label.slice(0, 3))}</abbr></th>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(monthLabel(year, month))} — ${escapeHtml(view.label)} — Baltimore Dealz</title>
  <link rel="stylesheet" href="${escapeHtml(options.styleHref ?? "/style.css")}">
</head>
<body>
  <header>
    <h1>${escapeHtml(view.label)} calendar</h1>
    <p class="meta"><a href="${escapeHtml(boardHref)}">Back to the board</a></p>
  </header>
  <main>
    <nav class="cal-nav meta">
      ${monthNav(prev, `← ${monthLabel(prev.year, prev.month)}`)}
      <strong>${escapeHtml(monthLabel(year, month))}</strong>
      ${monthNav(next, `${monthLabel(next.year, next.month)} →`)}
    </nav>
    <table class="cal-grid">
      <caption class="meta">Deals and events in ${escapeHtml(monthLabel(year, month))}. Deals are prices; events are dates.</caption>
      <thead><tr>${head}</tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    ${entries || `<p class="meta">Nothing on the calendar for ${escapeHtml(monthLabel(year, month))} yet.</p>`}
  </main>
</body>
</html>
`;
}

// "2026-12" -> {year, month}. Anything unparseable falls back to the month
// `now` is in, so a hand-typed URL never 500s.
export function parseMonthParam(raw, now = new Date()) {
  const match = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12 && year >= 2000 && year <= 2100) return { year, month };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
  })
    .format(now)
    .split("-");
  return { year: Number(parts[0]), month: Number(parts[1]) };
}
