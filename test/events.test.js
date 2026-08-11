// Events feed + calendar page.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_CATEGORIES,
  addMonths,
  eventShapeErrors,
  eventsOnDate,
  loadEvents,
  monthGrid,
  monthLabel,
  todayIso,
} from "../src/events.js";
import { dayContents, parseMonthParam, renderCalendar } from "../src/month.js";
import { venuesInView } from "../src/deals.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";

function ev(overrides = {}) {
  return {
    id: "test-event",
    title: "Test Event",
    date: "2026-09-20",
    time: "13:00",
    place: "Somewhere",
    category: "sports",
    source_url: "https://example.com/schedule",
    ...overrides,
  };
}

// ---- shape ----------------------------------------------------------------

test("a well-formed event passes validation", () => {
  assert.deepEqual(eventShapeErrors(ev()), []);
  // time is optional — an all-day event has no clock.
  const { time, ...allDay } = ev();
  assert.deepEqual(eventShapeErrors(allDay), []);
});

test("an event without a checkable source is rejected", () => {
  for (const bad of [undefined, "", "not-a-url", "ftp://x/y"]) {
    const errors = eventShapeErrors(ev({ source_url: bad }));
    assert.ok(
      errors.some((e) => e.includes("source_url")),
      `source_url ${JSON.stringify(bad)} was accepted`,
    );
  }
});

test("bad date, time, category and unknown keys all fail", () => {
  assert.ok(eventShapeErrors(ev({ date: "20 Sep 2026" })).some((e) => e.includes("date must be")));
  assert.ok(eventShapeErrors(ev({ time: "1pm" })).some((e) => e.includes("time must be")));
  assert.ok(eventShapeErrors(ev({ time: "25:00" })).some((e) => e.includes("time must be")));
  assert.ok(eventShapeErrors(ev({ category: "sportsball" })).some((e) => e.includes("category must be")));
  assert.ok(eventShapeErrors(ev({ price: "$5" })).some((e) => e.includes('unknown field "price"')));
});

test("every shipped event is shape-legal and in a known category", async () => {
  const events = await loadEvents();
  assert.ok(events.length > 0, "no events shipped — this test proves nothing");
  for (const event of events) {
    assert.deepEqual(eventShapeErrors(event), [], `${event.id} is not shape-legal`);
    assert.ok(EVENT_CATEGORIES.includes(event.category));
  }
});

test("shipped events are Baltimore venues only — no spring training in Sarasota", async () => {
  const places = new Set((await loadEvents()).map((e) => e.place));
  assert.deepEqual(
    [...places].sort(),
    ["M&T Bank Stadium", "Oriole Park at Camden Yards"],
  );
});

test("events cite the league's own schedule, never an aggregator", async () => {
  for (const event of await loadEvents()) {
    assert.match(event.source_url, /baltimoreravens\.com|mlb\.com/);
  }
});

// The Thursday-night game is the one that catches naive date handling: the
// Ravens feed publishes 2026-11-06T01:15:00 with no timezone, which is
// 8:15pm on 5 November in Baltimore. A wrong reading files it a day late.
test("a late kickoff lands on the Baltimore calendar day, not the UTC one", async () => {
  const jags = (await loadEvents()).find((e) => /Jaguars/.test(e.title));
  assert.ok(jags, "Jaguars home game missing from the feed");
  assert.equal(jags.date, "2026-11-05");
  assert.equal(jags.time, "20:15");
});

// ---- selection ------------------------------------------------------------

test("eventsOnDate returns only that day, ordered by time", () => {
  const events = [
    ev({ id: "b", date: "2026-09-20", time: "19:00", title: "Late" }),
    ev({ id: "a", date: "2026-09-20", time: "13:00", title: "Early" }),
    ev({ id: "c", date: "2026-09-21", time: "13:00", title: "Tomorrow" }),
  ];
  assert.deepEqual(eventsOnDate(events, "2026-09-20").map((e) => e.title), ["Early", "Late"]);
  assert.deepEqual(eventsOnDate(events, "2026-09-22"), []);
});

// ---- month grid -----------------------------------------------------------

test("monthGrid covers whole Monday-first weeks and flags days outside the month", () => {
  const cells = monthGrid(2026, 8); // Aug 2026 starts on a Saturday
  assert.equal(cells.length % 7, 0);
  assert.equal(cells[0].dayKey, "mon");
  const inMonth = cells.filter((c) => c.inMonth);
  assert.equal(inMonth.length, 31);
  assert.equal(inMonth[0].iso, "2026-08-01");
  assert.equal(inMonth.at(-1).iso, "2026-08-31");
  // Leading cells belong to July and must be flagged out.
  assert.equal(cells[0].inMonth, false);
});

test("monthGrid handles a February and a leap year", () => {
  assert.equal(monthGrid(2026, 2).filter((c) => c.inMonth).length, 28);
  assert.equal(monthGrid(2028, 2).filter((c) => c.inMonth).length, 29);
});

test("addMonths rolls the year at both ends", () => {
  assert.deepEqual(addMonths(2026, 1, -1), { year: 2025, month: 12 });
  assert.deepEqual(addMonths(2026, 12, 1), { year: 2027, month: 1 });
});

test("monthLabel reads as a person would write it", () => {
  assert.equal(monthLabel(2026, 12), "December 2026");
});

test("parseMonthParam accepts YYYY-MM and falls back rather than throwing", () => {
  assert.deepEqual(parseMonthParam("2026-12"), { year: 2026, month: 12 });
  const now = new Date("2026-08-10T16:00:00Z");
  for (const bad of [null, "", "nonsense", "2026-13", "2026-00", "1200-05"]) {
    assert.deepEqual(parseMonthParam(bad, now), { year: 2026, month: 8 }, `${bad} did not fall back`);
  }
});

test("todayIso follows Baltimore, not UTC", () => {
  // 01:30 UTC on the 11th is still the 10th in Baltimore.
  assert.equal(todayIso(new Date("2026-08-11T01:30:00Z")), "2026-08-10");
});

// ---- the page -------------------------------------------------------------

test("the calendar page renders the month, its days, and both feeds", async () => {
  const venues = await loadVenues();
  const events = await loadEvents();
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const html = renderCalendar(venuesInView(venues, city), events, city, views, { year: 2026, month: 9 });

  assert.match(html, /September 2026/);
  // Paging links both ways.
  assert.match(html, /month=2026-08/);
  assert.match(html, /month=2026-10/);
  // A real event with its dated heading — "September 20" is Eric's
  // "December 5th — XYZ" shape.
  assert.match(html, /Saints/);
  assert.match(html, /Sunday, September 20/);
  // And a deal, from the other feed.
  assert.match(html, /class="cal-deals"/);
});

test("Lee's monthly burger appears on the calendar's first Wednesday only", async () => {
  const venues = await loadVenues();
  const events = await loadEvents();
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const html = renderCalendar(venuesInView(venues, city), events, city, views, { year: 2026, month: 9 });

  // September 2026: Wednesdays are the 2nd, 9th, 16th, 23rd, 30th.
  const section = (iso) => {
    const start = html.indexOf(`id="day-${iso}"`);
    if (start === -1) return "";
    const end = html.indexOf("</section>", start);
    return html.slice(start, end);
  };
  assert.match(section("2026-09-02"), /Double Cheeseburger/);
  for (const iso of ["2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"]) {
    assert.doesNotMatch(section(iso), /Double Cheeseburger/, `burger leaked onto ${iso}`);
  }
});

test("a month with nothing in it says so instead of rendering an empty page", async () => {
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  // No venues, no events.
  const html = renderCalendar([], [], city, views, { year: 2027, month: 4 });
  assert.match(html, /Nothing on the calendar for April 2027/);
});

test("dayContents keeps deals and events apart", async () => {
  const venues = await loadVenues();
  const events = await loadEvents();
  const cells = monthGrid(2026, 9);
  const gameDay = cells.find((c) => c.iso === "2026-09-20");
  const { deals, events: dayEvents } = dayContents(venues, events, gameDay);
  assert.ok(dayEvents.some((e) => /Saints/.test(e.title)), "the game is missing");
  // A game is not a deal — it must never appear in the deal list.
  for (const row of deals) {
    for (const deal of row.deals) {
      assert.ok(!deal.items.some((i) => /Saints|Ravens/.test(i.text)));
    }
  }
});

test("the board links to the calendar page, not only the .ics feed", async () => {
  const { renderBoard } = await import("../src/page.js");
  const venues = await loadVenues();
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const html = renderBoard(venuesInView(venues, city), city, views, new Date("2026-08-10T16:00:00Z"));
  assert.match(html, /href="\/baltimore\/calendar"/);
  assert.match(html, /href="\/baltimore\/calendar\.ics"/);
});

test("event titles and sources are HTML-escaped", () => {
  const views = [{ slug: "baltimore", label: "Baltimore", neighborhoods: "*" }];
  const nasty = ev({
    id: "x",
    title: '<script>alert(1)</script>',
    date: "2026-09-20",
    source_url: "https://example.com/?a=1&b=2",
  });
  const html = renderCalendar([], [nasty], views[0], views, { year: 2026, month: 9 });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a=1&amp;b=2/);
});
