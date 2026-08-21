// Monthly recurrence tests.
import test from "node:test";
import assert from "node:assert/strict";

import {
  dealRunsOnDate,
  dealsForDay,
  isDealRenderable,
  isRenderable,
  ordinalOfDate,
  venueShapeErrors,
  venuesInView,
  WEEK,
} from "../src/deals.js";
import { renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, loadViews } from "../src/views.js";

function venue(overrides = {}) {
  return {
    id: "test-venue",
    name: "Test Venue",
    neighborhood: "Canton",
    status: "verified",
    address: "1 Main St",
    phone: "(410) 555-0100",
    source_url: "https://example.com",
    source_type: "venue_website",
    last_verified: "2026-08-03",
    deals: [{ days: WEEK.map((day) => day.key), items: [{ text: "$1 beer" }], start: null, end: null }],
    ...overrides,
  };
}

const CANTON = { slug: "canton", label: "Canton", neighborhoods: ["Canton", "Brewers Hill"] };

test("ordinalOfDate returns correct ordinal for known dates in Eastern time", () => {
  // First Wednesday of August 2026 = August 5
  const firstWed = new Date("2026-08-05T16:00:00Z");
  assert.equal(ordinalOfDate(firstWed, "wed"), "first");

  // Second Wednesday = August 12
  const secondWed = new Date("2026-08-12T16:00:00Z");
  assert.equal(ordinalOfDate(secondWed, "wed"), "second");

  // Third = August 19
  assert.equal(ordinalOfDate(new Date("2026-08-19T16:00:00Z"), "wed"), "third");

  // Fourth = August 26 (also "last" since Aug has 4 Wednesdays)
  assert.equal(ordinalOfDate(new Date("2026-08-26T16:00:00Z"), "wed"), "last");

  // Last day of the month (Monday Aug 31 = 5th Monday)
  const lastMon = new Date("2026-08-31T16:00:00Z");
  assert.equal(ordinalOfDate(lastMon, "mon"), "last");

  // Second Friday of Aug 2026 = Aug 14 (Aug 7 is first)
  const secondFri = new Date("2026-08-14T16:00:00Z");
  assert.equal(ordinalOfDate(secondFri, "fri"), "second");
});

test("a deal with no recurrence runs every week (default)", () => {
  const deal = { days: ["wed"], items: [{ text: "$1 beer" }] };
  const firstWed = new Date("2026-08-05T16:00:00Z");
  const secondWed = new Date("2026-08-12T16:00:00Z");

  assert.equal(dealRunsOnDate(deal, firstWed), true);
  assert.equal(dealRunsOnDate(deal, secondWed), true);
});

test("a deal with recurrence runs only on that ordinal", () => {
  const deal = { days: ["wed"], recurrence: "first", items: [{ text: "$5.99 burger" }] };
  const firstWed = new Date("2026-08-05T16:00:00Z");
  const secondWed = new Date("2026-08-12T16:00:00Z");
  const thirdWed = new Date("2026-08-19T16:00:00Z");
  const fourthWed = new Date("2026-08-26T16:00:00Z");

  assert.equal(dealRunsOnDate(deal, firstWed), true);
  assert.equal(dealRunsOnDate(deal, secondWed), false);
  assert.equal(dealRunsOnDate(deal, thirdWed), false);
  assert.equal(dealRunsOnDate(deal, fourthWed), false);
});

test("monthly recurrence: Lee's $5.99 burger renders on first Wednesday only", async () => {
  const venues = await loadVenues();
  const now = new Date("2026-08-05T16:00:00Z"); // First Wednesday Aug 2026
  const view = CANTON;

  const html = renderBoard(venuesInView(venues, view), view, [view], now);

  // On first Wednesday, the deal renders in "On tonight".
  assert.match(html, /Double Cheeseburger/);

  // Now check the other Wednesdays — must NOT render.
  const secondWed = new Date("2026-08-12T16:00:00Z");
  const thirdWed = new Date("2026-08-19T16:00:00Z");
  const fourthWed = new Date("2026-08-26T16:00:00Z");

  for (const date of [secondWed, thirdWed, fourthWed]) {
    const htmlOther = renderBoard(venuesInView(venues, view), view, [view], date);
    assert.doesNotMatch(
      htmlOther,
      /Double Cheeseburger/,
      `Lee's burger should not render on ${date.toISOString()}`,
    );
  }
});

test("recurrence must be one of the allowed ordinals", () => {
  const good = venue({
    deals: [{ days: ["wed"], items: [{ text: "$1 beer" }], start: null, end: null, recurrence: "first" }],
  });
  assert.deepEqual(venueShapeErrors(good), []);

  for (const bad of ["weekly", "monthly", "1st", "", "fifth"]) {
    const errors = venueShapeErrors(
      venue({
        deals: [{ days: ["wed"], items: [{ text: "$1 beer" }], start: null, end: null, recurrence: bad }],
      }),
    );
    assert.ok(
      errors.some((e) => e.includes("recurrence must be one of")),
      `recurrence "${bad}" was accepted`,
    );
  }
});

test("Lee's is verified with shape-legal monthly deal", async () => {
  const lees = (await loadVenues()).find((v) => v.id === "lees-pint-and-shell");
  assert.equal(lees.status, "verified");
  assert.deepEqual(venueShapeErrors(lees), []);
});

test("/baltimore showable count is 124 (2026-08-21 leftover loadable)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const inCity = venuesInView(venues, city);
  const showable = inCity.filter((v) => (v.deals || []).some((d) => d.status !== "held")).length;
  assert.equal(showable, 124);
  assert.equal(inCity.length, 146);
});

test("recurrence: dealsForDay with date respects monthly ordinal", () => {
  const v = venue({
    deals: [
      { days: ["wed"], recurrence: "first", items: [{ text: "First Wed" }], start: null, end: null },
      { days: ["wed"], items: [{ text: "Every Wed" }], start: null, end: null },
    ],
  });
  const firstWed = new Date("2026-08-05T16:00:00Z");
  const secondWed = new Date("2026-08-12T16:00:00Z");

  const first = dealsForDay([v], "wed", firstWed).flatMap((r) => r.deal.items.map((i) => i.text));
  const second = dealsForDay([v], "wed", secondWed).flatMap((r) => r.deal.items.map((i) => i.text));

  assert.deepEqual(first.sort(), ["Every Wed", "First Wed"]);
  assert.deepEqual(second, ["Every Wed"]);
});

test("recurrence: without a date, monthly deal acts weekly (backward-compat)", () => {
  const v = venue({
    deals: [
      { days: ["wed"], recurrence: "first", items: [{ text: "First Wed" }], start: null, end: null },
    ],
  });
  const rows = dealsForDay([v], "wed");
  assert.equal(rows.length, 1);
});

test("recurrence: an unknown recurrence key fails validation", () => {
  // Same as the hand-rolled hold field test — unknown key must be an error.
  const errors = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["wed"],
          items: [{ text: "$1 beer" }],
          start: null,
          end: null,
          monthly: "first", // unknown key, not the real "recurrence"
        },
      ],
    }),
  );
  assert.ok(errors.some((e) => e.includes('unknown field "monthly"')));
});