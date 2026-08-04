import test from "node:test";
import assert from "node:assert/strict";

import { BALTIMORE_TZ, WEEK, dayKeyInZone, dealsForDay, weekByDay } from "../src/deals.js";
import { renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";

// Both instants fall on Saturday in UTC, so anything that reads the day off the
// server's clock instead of Baltimore's will call them the same day.
const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z"); // Fri Aug 7, 11pm EDT
const SAT_1AM_EDT = new Date("2026-08-08T05:00:00Z"); // Sat Aug 8, 1am EDT

// Same trap in standard time, to prove the offset is not hardcoded to -4.
const FRI_11PM_EST = new Date("2026-01-10T04:00:00Z"); // Fri Jan 9, 11pm EST
const SAT_1AM_EST = new Date("2026-01-10T06:00:00Z"); // Sat Jan 10, 1am EST

test("late Friday and early Saturday are different days in Baltimore (EDT)", () => {
  assert.equal(dayKeyInZone(FRI_11PM_EDT), "fri");
  assert.equal(dayKeyInZone(SAT_1AM_EDT), "sat");
});

test("late Friday and early Saturday are different days in Baltimore (EST)", () => {
  assert.equal(dayKeyInZone(FRI_11PM_EST), "fri");
  assert.equal(dayKeyInZone(SAT_1AM_EST), "sat");
});

test("the time zone argument is honoured, not the machine's clock", () => {
  assert.equal(dayKeyInZone(FRI_11PM_EDT, BALTIMORE_TZ), "fri");
  assert.equal(dayKeyInZone(FRI_11PM_EDT, "UTC"), "sat");
});

test("the board at Friday 11pm and Saturday 1am is not the same board", async () => {
  const venues = await loadVenues();
  const friday = renderBoard(venues, FRI_11PM_EDT);
  const saturday = renderBoard(venues, SAT_1AM_EDT);

  assert.notEqual(friday, saturday);
  assert.match(friday, /Friday · Baltimore time/);
  assert.match(saturday, /Saturday · Baltimore time/);

  // Friday-only vs Saturday-only deals land on the right night.
  const onTonight = (html) => html.split("<h2>Good to know</h2>")[0];
  assert.match(onTonight(friday), /Free beer with lunch/);
  assert.doesNotMatch(onTonight(friday), /Spin the Wheel/);
  assert.match(onTonight(saturday), /Spin the Wheel/);
  assert.doesNotMatch(onTonight(saturday), /Free beer with lunch/);
});

test("dealsForDay returns only that day's deals", async () => {
  const venues = await loadVenues();
  const sunday = dealsForDay(venues, "sun").flatMap((row) => row.deal.items);

  assert.ok(sunday.includes("$10 cheesesteaks"));
  assert.ok(!sunday.includes("$10 pretzel pies")); // Monday
});

test("a deal listed on two days shows up on both", async () => {
  const venues = await loadVenues();
  const brunchDays = weekByDay(venues)
    .filter((day) => day.rows.some((row) => row.deal.items.includes("Brunch")))
    .map((day) => day.key);

  assert.deepEqual(brunchDays, ["sat", "sun"]);
});

test("every day of the week has at least one seeded deal", async () => {
  const venues = await loadVenues();
  for (const day of weekByDay(venues)) {
    assert.ok(day.rows.length > 0, `no deals seeded for ${day.key}`);
  }
});

// Guards the shape the incoming 10-12 spot list has to drop into.
test("venues.json matches the expected shape", async () => {
  const venues = await loadVenues();
  const dayKeys = new Set(WEEK.map((day) => day.key));

  assert.ok(venues.length > 0);
  for (const venue of venues) {
    for (const field of ["id", "name", "neighborhood", "address", "source_url", "source_type"]) {
      assert.equal(typeof venue[field], "string", `${venue.id}: ${field} must be a string`);
    }
    assert.match(venue.last_verified, /^\d{4}-\d{2}-\d{2}$/, `${venue.id}: last_verified must be YYYY-MM-DD`);
    assert.ok(Array.isArray(venue.deals) && venue.deals.length > 0, `${venue.id}: needs deals`);

    for (const deal of venue.deals) {
      assert.ok(Array.isArray(deal.days) && deal.days.length > 0, `${venue.id}: deal needs days`);
      for (const day of deal.days) {
        assert.ok(dayKeys.has(day), `${venue.id}: unknown day "${day}"`);
      }
      assert.ok(Array.isArray(deal.items) && deal.items.length > 0, `${venue.id}: deal needs items`);
      if (deal.time_window !== undefined) {
        assert.equal(typeof deal.time_window, "string");
      }
    }
  }
});

test("venue text is escaped, not injected raw", () => {
  const venues = [
    {
      id: "x",
      name: "Bar <script>alert(1)</script>",
      neighborhood: "Canton",
      address: "1 Main St",
      phone: "(410) 555-0100",
      source_url: "https://example.com",
      source_type: "venue_website",
      last_verified: "2026-08-03",
      deals: [{ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], items: ["$1 beer"] }],
    },
  ];

  const html = renderBoard(venues, FRI_11PM_EDT);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;/);
});
