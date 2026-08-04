import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BALTIMORE_TZ,
  WEEK,
  dayKeyInZone,
  dealsForDay,
  isDealRenderable,
  isRenderable,
  venueShapeErrors,
  venuesForView,
  weekByDay,
} from "../src/deals.js";
import { escapeHtml, renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, findView, loadViews } from "../src/views.js";

// Both instants fall on Saturday in UTC, so anything that reads the day off the
// server's clock instead of Baltimore's will call them the same day.
const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z"); // Fri Aug 7, 11pm EDT
const SAT_1AM_EDT = new Date("2026-08-08T05:00:00Z"); // Sat Aug 8, 1am EDT

// Same trap in standard time, to prove the offset is not hardcoded to -4.
const FRI_11PM_EST = new Date("2026-01-10T04:00:00Z"); // Fri Jan 9, 11pm EST
const SAT_1AM_EST = new Date("2026-01-10T06:00:00Z"); // Sat Jan 10, 1am EST

const CANTON = { slug: "canton", label: "Canton", neighborhoods: ["Canton", "Brewers Hill"] };

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
    deals: [{ days: WEEK.map((day) => day.key), items: ["$1 beer"] }],
    ...overrides,
  };
}

async function boardFor(date, view = CANTON) {
  const venues = venuesForView(await loadVenues(), view);
  return renderBoard(venues, view, [view], date);
}

// --- day selection -------------------------------------------------------

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
  const friday = await boardFor(FRI_11PM_EDT);
  const saturday = await boardFor(SAT_1AM_EDT);

  assert.notEqual(friday, saturday);
  assert.match(friday, /Friday · Baltimore time/);
  assert.match(saturday, /Saturday · Baltimore time/);

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
  const venues = venuesForView(await loadVenues(), CANTON);
  for (const day of weekByDay(venues)) {
    assert.ok(day.rows.length > 0, `no deals seeded for ${day.key}`);
  }
});

// --- status: unverified venues never reach the board ---------------------

test("the seed data really does contain unverified venues", async () => {
  const unverified = (await loadVenues()).filter((v) => !isRenderable(v));
  assert.ok(unverified.length > 0, "no unverified venue in the data — this test proves nothing");
  assert.deepEqual(
    unverified.map((v) => v.id).sort(),
    ["claddagh-pub", "lees-pint-and-shell"],
  );
});

test("an unverified venue never appears in the rendered board, any day", async () => {
  const all = await loadVenues();
  const unverified = all.filter((v) => !isRenderable(v));

  for (const day of WEEK) {
    // Pick a real instant on each weekday so every branch of the page renders.
    const instant = new Date(`2026-08-0${3 + WEEK.indexOf(day)}T16:00:00Z`);
    const html = await boardFor(instant);
    for (const hidden of unverified) {
      assert.ok(!html.includes(escapeHtml(hidden.name)), `${hidden.name} rendered on ${day.key}`);
    }
  }
});

test("dealsForDay itself drops unverified venues, not just the view filter", () => {
  const hidden = venue({ id: "hidden", name: "Hidden Bar", status: "open_unverifiable" });
  const rows = dealsForDay([hidden, venue()], "mon");

  assert.deepEqual(rows.map((row) => row.venue.id), ["test-venue"]);
});

test("venuesForView drops venues outside the view's neighborhoods", () => {
  const inView = venue({ id: "in", neighborhood: "Brewers Hill" });
  const outOfView = venue({ id: "out", neighborhood: "Federal Hill" });

  assert.deepEqual(
    venuesForView([inView, outOfView], CANTON).map((v) => v.id),
    ["in"],
  );
});

// --- held deal rows ------------------------------------------------------

test("the seed data really does contain held deal rows", async () => {
  const held = (await loadVenues()).flatMap((v) =>
    v.deals.filter((d) => !isDealRenderable(d)).map((d) => `${v.id}:${d.items[0]}`),
  );
  assert.ok(held.length > 0, "no held row in the data — the hold tests prove nothing");
  assert.equal(held.length, 3, held.join(", ")); // El Bufalo HH, Mama's Monday, Good Vibes HH
});

test("a held deal row never appears in the rendered board, any day", async () => {
  const heldItems = (await loadVenues()).flatMap((v) =>
    v.deals.filter((d) => !isDealRenderable(d)).flatMap((d) => d.items),
  );

  for (const day of WEEK) {
    const instant = new Date(`2026-08-0${3 + WEEK.indexOf(day)}T16:00:00Z`);
    const html = await boardFor(instant);
    for (const item of heldItems) {
      assert.ok(!html.includes(escapeHtml(item)), `held "${item}" rendered on ${day.key}`);
    }
  }
});

test("a venue whose only deal is held drops off the board but keeps its data", async () => {
  const all = await loadVenues();
  const elBufalo = all.find((v) => v.id === "el-bufalo");

  assert.equal(elBufalo.status, "verified");
  assert.ok(elBufalo.deals.every((d) => !isDealRenderable(d)));
  assert.deepEqual(venueShapeErrors(elBufalo), []); // still valid data

  // No deal card anywhere. Its note still shows under "Good to know" — that is
  // the ticket's "days question in notes", not a leak.
  const html = await boardFor(new Date("2026-08-08T20:00:00Z")); // a Saturday
  assert.ok(!html.includes(`<h3>${escapeHtml(elBufalo.name)}`), "El Bufalo has a deal card");
  for (const item of elBufalo.deals.flatMap((d) => d.items)) {
    assert.ok(!html.includes(escapeHtml(item)), `held item "${item}" rendered`);
  }
});

test("dealsForDay drops held rows but keeps the venue's other rows", () => {
  const v = venue({
    deals: [
      { days: ["mon"], items: ["Shows up"] },
      { days: ["mon"], items: ["Held back"], status: "held" },
    ],
  });
  const items = dealsForDay([v], "mon").flatMap((row) => row.deal.items);

  assert.deepEqual(items, ["Shows up"]);
});

test("an unknown deal status fails validation", () => {
  for (const status of ["open_unverifiable", "verified", "hold", "HELD", "", null, false]) {
    const errors = venueShapeErrors(
      venue({ deals: [{ days: ["mon"], items: ["$1 beer"], status }] }),
    );
    assert.ok(
      errors.some((e) => e.includes("deal status")),
      `status ${JSON.stringify(status)} was accepted`,
    );
  }
});

test("a hand-rolled hold field on a deal fails validation instead of rendering", () => {
  // The exact silent-failure shape: mark a row your own way, suite stays green,
  // deal ships anyway. These must all be hard errors now.
  for (const field of ["verified", "hold", "held", "unverified", "render", "notes"]) {
    const errors = venueShapeErrors(
      venue({ deals: [{ days: ["mon"], items: ["$1 beer"], [field]: false }] }),
    );
    assert.ok(
      errors.some((e) => e.includes(`unknown field "${field}"`)),
      `deal field "${field}" was silently ignored`,
    );
  }
});

// --- shape validation ----------------------------------------------------

test("every venue in venues.json is well formed", async () => {
  const venues = await loadVenues();
  assert.ok(venues.length > 0);
  for (const v of venues) {
    assert.deepEqual(venueShapeErrors(v), [], `${v.id} is malformed`);
  }
});

test("a verified venue with no deals fails validation", () => {
  const errors = venueShapeErrors(venue({ deals: [] }));
  assert.ok(errors.some((e) => e.includes("needs at least one deal")), errors.join("; "));
});

test("an unverified venue with no deals is legal", () => {
  const errors = venueShapeErrors(
    venue({ status: "open_unverifiable", deals: [], phone: undefined, source_url: undefined }),
  );
  assert.deepEqual(errors, []);
});

test("a verified venue with malformed deals still fails validation", () => {
  const cases = [
    { deals: [{ days: ["monday"], items: ["$1 beer"] }] }, // not a day key
    { deals: [{ days: [], items: ["$1 beer"] }] },
    { deals: [{ days: ["mon"], items: [] }] },
    { deals: [{ days: ["mon"] }] },
    { deals: [{ days: ["mon"], items: ["$1 beer"], time_window: 7 }] },
    { last_verified: "8/3/2026" },
    { last_verified: undefined },
    { source_type: undefined },
    { status: "probably-fine" },
    { name: "" },
  ];

  for (const overrides of cases) {
    const errors = venueShapeErrors(venue(overrides));
    assert.ok(errors.length > 0, `expected errors for ${JSON.stringify(overrides)}`);
  }
});

// --- render guard: a missing optional field drops a line, not the board ---

test("a venue with no phone renders without its phone line", () => {
  const noPhone = venue({ phone: undefined });
  const html = renderBoard([noPhone], CANTON, [CANTON], FRI_11PM_EDT);

  assert.match(html, /Test Venue/);
  assert.doesNotMatch(html, /href="tel:/);
  assert.match(html, /last verified 2026-08-03/);
});

test("a venue missing every optional field still renders", () => {
  const bare = venue({
    address: undefined,
    phone: undefined,
    source_url: undefined,
    source_type: "venue_website",
  });
  const html = renderBoard([bare], CANTON, [CANTON], FRI_11PM_EDT);

  assert.match(html, /Test Venue/);
  assert.doesNotMatch(html, /undefined/);
});

test("the real seed data has venues that would have 500'd the old render", async () => {
  const venues = venuesForView(await loadVenues(), CANTON);
  const phoneless = venues.filter((v) => !v.phone);

  assert.ok(phoneless.length > 0, "no phoneless venue — the guard test proves nothing");
  const html = renderBoard(venues, CANTON, [CANTON], FRI_11PM_EDT);
  for (const v of phoneless) {
    assert.ok(html.includes(escapeHtml(v.name)), `${v.name} missing from board`);
  }
});

// --- views ---------------------------------------------------------------

test("the page title comes from the view, not a hard-coded neighborhood", () => {
  const elsewhere = { slug: "fed-hill", label: "Federal Hill", neighborhoods: ["Federal Hill"] };
  const html = renderBoard(
    [venue({ neighborhood: "Federal Hill" })],
    elsewhere,
    [elsewhere],
    FRI_11PM_EDT,
  );

  assert.match(html, /<h1>Tonight in Federal Hill<\/h1>/);
  assert.doesNotMatch(html, /Canton/);
});

test("no source file hard-codes Canton", async () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (await readdir(srcDir)).map((name) => `${srcDir}${name}`);
  files.push(fileURLToPath(new URL("../server.js", import.meta.url)));

  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.ok(!/canton/i.test(text), `${file} mentions Canton`);
  }
});

test("the switcher is hidden with one view and shown with two", () => {
  const other = { slug: "fed-hill", label: "Federal Hill", neighborhoods: ["Federal Hill"] };

  const alone = renderBoard([venue()], CANTON, [CANTON], FRI_11PM_EDT);
  assert.doesNotMatch(alone, /<nav/);

  const paired = renderBoard([venue()], CANTON, [CANTON, other], FRI_11PM_EDT);
  assert.match(paired, /<nav/);
  assert.match(paired, /href="\/fed-hill"/);
});

test("views.json has a usable default view", async () => {
  const views = await loadViews();
  assert.ok(views.length > 0);

  const fallback = defaultView(views);
  assert.equal(typeof fallback.slug, "string");
  assert.equal(findView(views, fallback.slug), fallback);
  assert.equal(findView(views, "no-such-view"), undefined);

  for (const view of views) {
    assert.ok(Array.isArray(view.neighborhoods) && view.neighborhoods.length > 0);
    assert.equal(typeof view.label, "string");
  }
});

test("every venue's neighborhood belongs to some view", async () => {
  const covered = new Set((await loadViews()).flatMap((view) => view.neighborhoods));
  for (const v of await loadVenues()) {
    assert.ok(covered.has(v.neighborhood), `${v.id}: "${v.neighborhood}" is in no view`);
  }
});

// --- escaping ------------------------------------------------------------

test("venue text is escaped, not injected raw", () => {
  const nasty = venue({
    name: "Bar <script>alert(1)</script>",
    notes: '<img src=x onerror="alert(2)">',
    deals: [{ days: WEEK.map((d) => d.key), items: ["<b>$1 beer</b>"], time_window: '"><i>' }],
  });

  const html = renderBoard([nasty], CANTON, [CANTON], FRI_11PM_EDT);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>$1 beer</b>"));
  assert.match(html, /&lt;script&gt;/);
});

test("notes from a non-rendering venue never reach the page", () => {
  const hidden = venue({
    id: "hidden",
    name: "Hidden Bar",
    status: "open_unverifiable",
    deals: [],
    notes: "SECRET-RESEARCH-NOTE",
  });

  const html = renderBoard([hidden, venue()], CANTON, [CANTON], FRI_11PM_EDT);
  assert.ok(!html.includes("SECRET-RESEARCH-NOTE"));
});

test("neighborhood labels come from the city boundary layer, with provenance", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  // Both of these read the other way round before the city's point-in-polygon
  // check; the seed venue was the Brewers Hill one all along.
  assert.equal(byId["hucks-american-craft"].neighborhood, "Brewers Hill");
  assert.equal(byId["union-hill-kitchen"].neighborhood, "Canton");

  assert.deepEqual(
    venues.filter((v) => v.neighborhood === "Brewers Hill").map((v) => v.id),
    ["hucks-american-craft"],
  );

  for (const v of venues) {
    assert.match(
      v.neighborhood_source ?? "",
      /^Baltimore City Neighborhood Statistical Areas/,
      `${v.id} has no neighborhood provenance`,
    );
  }
});
