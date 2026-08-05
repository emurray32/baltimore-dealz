import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BALTIMORE_TZ,
  WEEK,
  dayKeyInZone,
  dealsForDay,
  hasEnded,
  hasShowableDeal,
  isDealRenderable,
  isRenderable,
  noDealVenues,
  venueShapeErrors,
  venuesForView,
  venuesInView,
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
    deals: [{ days: WEEK.map((day) => day.key), items: [{ text: "$1 beer" }], start: null, end: null }],
    ...overrides,
  };
}

async function boardFor(date, view = CANTON) {
  // Full neighborhood list — deal cards + the collapsed no-deal group.
  const venues = venuesInView(await loadVenues(), view);
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
  assert.match(onTonight(friday), /Free Beer When You Buy Lunch/);
  assert.doesNotMatch(onTonight(friday), /Spin the Wheel/);
  assert.match(onTonight(saturday), /Spin the Wheel/);
  assert.doesNotMatch(onTonight(saturday), /Free Beer When You Buy Lunch/);
});

test("dealsForDay returns only that day's deals", async () => {
  const venues = await loadVenues();
  const sunday = dealsForDay(venues, "sun").flatMap((row) => row.deal.items.map((i) => i.text));

  assert.ok(sunday.includes("$10 Cheesesteaks"));
  assert.ok(!sunday.includes("$10 Pretzel Pies")); // Monday
});

test("a deal listed on two days shows up on both", async () => {
  const venues = await loadVenues();
  const brunchDays = weekByDay(venues)
    .filter((day) => day.rows.some((row) => row.deal.items.some((i) => i.text === "Brunch")))
    .map((day) => day.key);

  assert.deepEqual(brunchDays, ["sat", "sun"]);
});

test("every day of the week has at least one seeded deal", async () => {
  const venues = venuesInView(await loadVenues(), CANTON);
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
    [
      "baltimore-tap-house",
      "bo-brooks",
      "honeypot",
      "lees-pint-and-shell",
      "sopro",
      "sports-balls",
      "the-worthington",
      "walts-inn",
    ],
  );
});

test("an unverified venue never appears as a deal card, any day", async () => {
  const all = await loadVenues();
  const unverified = all.filter((v) => !isRenderable(v));

  for (const day of WEEK) {
    // Pick a real instant on each weekday so every branch of the page renders.
    const instant = new Date(`2026-08-0${3 + WEEK.indexOf(day)}T16:00:00Z`);
    const html = await boardFor(instant);
    for (const hidden of unverified) {
      assert.ok(
        !html.includes(`<h3>${escapeHtml(hidden.name)}`),
        `${hidden.name} has a deal card on ${day.key}`,
      );
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
    v.deals.filter((d) => !isDealRenderable(d)).map((d) => `${v.id}:${d.items[0].text}`),
  );
  assert.ok(held.length > 0, "no held row in the data — the hold tests prove nothing");
  assert.deepEqual(held.sort(), [
    "el-bufalo:16oz Modelo Especial $3", // days never published on site or Instagram
    "good-vibes-cantina:$7 Margaritas", // bio 3-7pm vs posts 4-8pm
    "mamas-on-the-half-shell:Happy Hour ALL DAY", // website vs Instagram Monday
    "pig-and-rooster-smokehouse:$5 Burger of the Day (rotating)", // source line has $5 AND $7
  ]);
});

// Scoped per venue on purpose: the same item text can be held for one venue and
// legitimately rendered for another ("$7 Margaritas" is held at Good Vibes and
// a real Tuesday deal at Smaltimore), so a global substring check false-fails.
function cardsFor(html, venueName) {
  return html
    .split("<article")
    .filter((block) => block.includes(`<h3>${escapeHtml(venueName)}`));
}

test("a held deal row never appears in the rendered board, any day", async () => {
  const venues = await loadVenues();

  for (const day of WEEK) {
    const instant = new Date(`2026-08-0${3 + WEEK.indexOf(day)}T16:00:00Z`);
    const html = await boardFor(instant);

    for (const venue of venues) {
      const blocks = cardsFor(html, venue.name).join("");
      for (const deal of venue.deals.filter((d) => !isDealRenderable(d))) {
        for (const item of deal.items) {
          assert.ok(
            !blocks.includes(escapeHtml(item.text)),
            `held "${item.text}" rendered for ${venue.name} on ${day.key}`,
          );
        }
      }
    }
  }
});

test("a venue whose only deal is held drops off deal cards but keeps its data", async () => {
  const all = await loadVenues();
  const elBufalo = all.find((v) => v.id === "el-bufalo");

  assert.equal(elBufalo.status, "verified");
  assert.ok(elBufalo.deals.every((d) => !isDealRenderable(d)));
  assert.deepEqual(venueShapeErrors(elBufalo), []); // still valid data
  assert.equal(hasShowableDeal(elBufalo), false);

  // No deal card anywhere. Held offer text never renders. Name + reason land
  // in the collapsed no-deal group instead.
  const html = await boardFor(new Date("2026-08-08T20:00:00Z")); // a Saturday
  assert.ok(!html.includes(`<h3>${escapeHtml(elBufalo.name)}`), "El Bufalo has a deal card");
  for (const item of elBufalo.deals.flatMap((d) => d.items.map((i) => i.text))) {
    assert.ok(!html.includes(escapeHtml(item)), `held item "${item}" rendered`);
  }
  assert.match(html, /El Bufalo Tequila Bar \+ Kitchen/);
  assert.match(html, /name no days on their site or Instagram/);
});

test("dealsForDay drops held rows but keeps the venue's other rows", () => {
  const v = venue({
    deals: [
      { days: ["mon"], items: [{ text: "Shows up" }], start: null, end: null },
      { days: ["mon"], items: [{ text: "Held back" }], start: null, end: null, status: "held" },
    ],
  });
  const items = dealsForDay([v], "mon").flatMap((row) => row.deal.items.map((i) => i.text));

  assert.deepEqual(items, ["Shows up"]);
});

test("an unknown deal status fails validation", () => {
  for (const status of ["open_unverifiable", "verified", "hold", "HELD", "", null, false]) {
    const errors = venueShapeErrors(
      venue({ deals: [{ days: ["mon"], items: [{ text: "$1 beer" }], start: null, end: null, status }] }),
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
      venue({ deals: [{ days: ["mon"], items: [{ text: "$1 beer" }], start: null, end: null, [field]: false }] }),
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
    { deals: [{ days: ["monday"], items: [{ text: "$1 beer" }], start: null, end: null }] }, // not a day key
    { deals: [{ days: [], items: [{ text: "$1 beer" }], start: null, end: null }] },
    { deals: [{ days: ["mon"], items: [], start: null, end: null }] },
    { deals: [{ days: ["mon"], start: null, end: null }] },
    { deals: [{ days: ["mon"], items: [{ text: "$1 beer" }], time_window: 7, start: null, end: null }] },
    { last_verified: "8/3/2026" },
    { last_verified: undefined },
    { source_type: undefined },
    { source_type: "website_text" }, // stray free-string; legend is venue_website | instagram_profile | none
    { status: "probably-fine" },
    { name: "" },
  ];

  for (const overrides of cases) {
    const errors = venueShapeErrors(venue(overrides));
    assert.ok(errors.length > 0, `expected errors for ${JSON.stringify(overrides)}`);
  }
});

test("source_type must be one of the legend values", () => {
  assert.deepEqual(venueShapeErrors(venue({ source_type: "venue_website" })), []);
  assert.deepEqual(venueShapeErrors(venue({ source_type: "instagram_profile" })), []);
  const bad = venueShapeErrors(venue({ source_type: "website_text" }));
  assert.ok(bad.some((e) => e.includes("source_type must be one of")), bad.join("; "));
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
  const venues = venuesInView(await loadVenues(), CANTON);
  const phoneless = venues.filter((v) => hasShowableDeal(v) && !v.phone);

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
    notes_public: '<img src=x onerror="alert(2)">',
    deals: [{ days: WEEK.map((d) => d.key), items: [{ text: "<b>$1 beer</b>" }], time_window: '"><i>' }],
  });

  const html = renderBoard([nasty], CANTON, [CANTON], FRI_11PM_EDT);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<b>$1 beer</b>"));
  assert.match(html, /&lt;script&gt;/);
});

test("ops_notes from a no-deal venue never reach the page", () => {
  const hidden = venue({
    id: "hidden",
    name: "Hidden Bar",
    status: "open_unverifiable",
    deals: [],
    notes_public: "No specials we can verify.",
    ops_notes: "SECRET-RESEARCH-NOTE",
  });

  const html = renderBoard([hidden, venue()], CANTON, [CANTON], FRI_11PM_EDT);
  assert.ok(!html.includes("SECRET-RESEARCH-NOTE"));
  // Public reason is what the collapsed group is for.
  assert.match(html, /Hidden Bar/);
  assert.match(html, /No specials we can verify/);
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

// --- BD-2c: structured times, prices, notes split -------------------------

test("end:null cannot render as ended, at any minute of the day", async () => {
  const venues = await loadVenues();
  const openEnded = venues.flatMap((v) => v.deals.filter((d) => d.end === null));

  assert.ok(openEnded.length > 0, "no open-ended deal in the data — this proves nothing");
  for (const deal of openEnded) {
    for (let minute = 0; minute < 1440; minute += 7) {
      assert.equal(hasEnded(deal, minute), false);
    }
  }
});

test("a deal with a published end time does end", () => {
  const deal = { start: 15 * 60, end: 18 * 60 };
  assert.equal(hasEnded(deal, 17 * 60), false);
  assert.equal(hasEnded(deal, 18 * 60), true);
  assert.equal(hasEnded(deal, 23 * 60), true);
});

test("Huck's nightcaps start at 11pm and never read as ended", async () => {
  // Deal Scout's proof case: their kitchen closes 10pm, the deal starts 11pm.
  const hucks = (await loadVenues()).find((v) => v.id === "hucks-american-craft");
  const nightcaps = hucks.deals.find((d) => d.items.some((i) => i.text === "$7 Nightcaps"));

  assert.equal(nightcaps.start, 23 * 60);
  assert.equal(nightcaps.end, null);
  assert.equal(hasEnded(nightcaps, 23 * 60 + 1), false);
});

test("start and end are minutes past midnight or null, never a string", async () => {
  for (const v of await loadVenues()) {
    for (const deal of v.deals) {
      for (const field of ["start", "end"]) {
        const value = deal[field];
        assert.ok(
          value === null || (Number.isInteger(value) && value >= 0 && value < 1440),
          `${v.id}: ${field} = ${JSON.stringify(value)}`,
        );
      }
      if (deal.start !== null && deal.end !== null) {
        assert.ok(deal.end > deal.start, `${v.id}: end is not after start`);
      }
    }
  }
});

test("prices are strings, because BOGO and 1/2 off are real prices", async () => {
  const prices = (await loadVenues())
    .flatMap((v) => v.deals.flatMap((d) => d.items))
    .filter((i) => i.price !== undefined)
    .map((i) => i.price);

  for (const p of prices) assert.equal(typeof p, "string");
  for (const nonNumeric of ["BOGO", "1/2 off", "Free", "1/2 price"]) {
    assert.ok(prices.includes(nonNumeric), `no ${nonNumeric} price survived the migration`);
  }
});

test("the $50 gift card is not a price", async () => {
  // The trap: any grab-the-dollar-amount pass puts a $50 chip on a free trivia night.
  const dive = (await loadVenues()).find((v) => v.id === "the-dive");
  const trivia = dive.deals.flatMap((d) => d.items).find((i) => i.text.includes("Bmore Trivia"));

  assert.match(trivia.text, /\$50 gift card/);
  assert.equal(trivia.price, undefined);
});

test("no-price states stay distinct", async () => {
  const venues = await loadVenues();

  // (1) priceless item: an event, no price field, prices_published not set
  const trivia = venues
    .find((v) => v.id === "ellies-tavern")
    .deals.flatMap((d) => d.items)
    .find((i) => i.text === "Trivia Night");
  assert.equal(trivia.price, undefined);

  // (2) venue published times but no prices
  const stackhouse = venues.find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stackhouse.deals.every((d) => d.prices_published === false));

  // (3) held — a different fact again, and it never renders
  const held = venues.flatMap((v) => v.deals).filter((d) => !isDealRenderable(d));
  assert.ok(held.length > 0);
});

test("prices_published:false renders an honest flag, not a blank", async () => {
  const html = await boardFor(new Date("2026-08-03T20:00:00Z")); // a Monday
  assert.match(html, /Prices not published by the venue\./);
});

test("ops_notes never reach the page; notes_public do", async () => {
  const venues = await loadVenues();
  const withOps = venues.filter((v) => v.ops_notes);
  const withPublic = venues.filter((v) => v.notes_public && isRenderable(v));

  assert.ok(withOps.length > 0 && withPublic.length > 0);

  for (const day of WEEK) {
    const html = await boardFor(new Date(`2026-08-0${3 + WEEK.indexOf(day)}T16:00:00Z`));
    for (const v of withOps) {
      assert.ok(!html.includes(escapeHtml(v.ops_notes)), `${v.id} ops_notes leaked on ${day.key}`);
    }
  }

  const monday = await boardFor(new Date("2026-08-03T20:00:00Z"));
  for (const v of withPublic) {
    assert.ok(monday.includes(escapeHtml(v.notes_public)), `${v.id} notes_public missing`);
  }
});

test("no venue carries the retired single notes field", async () => {
  for (const v of await loadVenues()) {
    assert.equal(v.notes, undefined, `${v.id} still has a bare notes field`);
  }
});

test("Lee's carries the image-only deal format", async () => {
  const lees = (await loadVenues()).find((v) => v.id === "lees-pint-and-shell");
  assert.equal(lees.deal_format, "image");
  assert.deepEqual(lees.deals, []);

  assert.ok(venueShapeErrors(venue({ deal_format: "image" })).length === 0);
  assert.ok(venueShapeErrors(venue({ deal_format: "pdf" })).some((e) => e.includes("deal_format")));
});

test("bar_hours is set only where the venue actually labelled it", async () => {
  const withBar = (await loadVenues()).filter((v) => v.bar_hours).map((v) => v.id).sort();
  assert.deepEqual(withBar, ["claddagh-pub", "hudson-street-stackhouse", "the-dive"]);
});

test("an unknown key on an item fails validation", () => {
  for (const field of ["prices_published", "value", "cost", "price_numeric"]) {
    const errors = venueShapeErrors(
      venue({ deals: [{ days: ["mon"], items: [{ text: "x", [field]: 1 }], start: null, end: null }] }),
    );
    assert.ok(
      errors.some((e) => e.includes(`unknown field "${field}" on an item`)),
      `item field "${field}" was silently ignored`,
    );
  }
});

test("the data records which state of the master file it came from", async () => {
  const raw = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../data/venues.json", import.meta.url),
      "utf8",
    ),
  );
  assert.match(raw.derived_from, /CANTON_DEALS\.md as of 2026-08-05.*sha256 24cef257/);
  assert.equal(raw.schema_version, 5);
});

// --- coordinates + per-deal source URL ------------------------------------

test("coordinates carry OSM provenance and cover every researched row except Sports Balls", async () => {
  const venues = await loadVenues();
  const withCoords = venues.filter((v) => v.lat !== undefined);
  const without = venues.filter((v) => v.lat === undefined).map((v) => v.id);

  assert.equal(withCoords.length, 21);
  assert.deepEqual(without, ["sports-balls"]);

  for (const v of withCoords) {
    assert.equal(typeof v.lat, "number");
    assert.equal(typeof v.lon, "number");
    assert.match(
      v.coords_source ?? "",
      /OpenStreetMap Nominatim.*not venue-published/,
      `${v.id} missing coords provenance`,
    );
    assert.deepEqual(venueShapeErrors(v), [], `${v.id} shape with coords`);
  }
});

test("a deal source_url wins over the venue homepage on the card", () => {
  const v = venue({
    source_url: "https://example.com/homepage",
    deals: [
      {
        days: ["mon"],
        items: [{ text: "Brunch" }],
        start: null,
        end: null,
        source_url: "https://instagram.com/example",
      },
    ],
  });
  const html = renderBoard([v], CANTON, [CANTON], FRI_11PM_EDT);

  assert.match(html, /href="https:\/\/instagram\.com\/example"/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/homepage"/);
});

test("Mama's brunch card links to Instagram, not the venue website", async () => {
  const venues = venuesForView(await loadVenues(), CANTON);
  // A Saturday board carries Mama's brunch. Scope to brunch cards — the week
  // accordion also carries the Mon–Fri HH row, which attributes to the website.
  const html = renderBoard(venues, CANTON, [CANTON], new Date("2026-08-08T16:00:00Z"));
  const brunchCards = cardsFor(html, "Mama's on the Half Shell").filter((b) =>
    b.includes("Bottomless Brunch"),
  );
  assert.ok(brunchCards.length > 0, "expected brunch card");
  const brunchHtml = brunchCards.join("");

  assert.match(brunchHtml, /href="https:\/\/www\.instagram\.com\/mamasonthehalfshell\/"/);
  assert.doesNotMatch(brunchHtml, /href="https:\/\/www\.mamasonthehalfshell\.com\/"/);
});

test("Mama's Mon–Fri happy hour attributes to the website, not Instagram", async () => {
  const mama = (await loadVenues()).find((v) => v.id === "mamas-on-the-half-shell");
  const weekdayHh = mama.deals.find(
    (d) =>
      d.days.length === 5 &&
      d.days.includes("mon") &&
      d.items.some((i) => i.text === "Happy Hour") &&
      d.status !== "held",
  );
  assert.ok(weekdayHh, "expected rendered Mon–Fri Happy Hour row");
  assert.equal(weekdayHh.source_url, "https://www.mamasonthehalfshell.com/");

  // The Instagram "ALL DAY Mondays" copy stays held and still cites Instagram.
  const monAllDay = mama.deals.find((d) =>
    d.items.some((i) => i.text === "Happy Hour ALL DAY"),
  );
  assert.equal(monAllDay?.status, "held");
  assert.equal(monAllDay?.source_url, "https://www.instagram.com/mamasonthehalfshell/");

  const venues = venuesForView(await loadVenues(), CANTON);
  // Wednesday: HH is on tonight; brunch lives only in the week accordion.
  // Scope assertions to the HH card so brunch Instagram does not false-fail.
  const html = renderBoard(venues, CANTON, [CANTON], new Date("2026-08-05T20:00:00Z"));
  const hhCards = cardsFor(html, "Mama's on the Half Shell").filter(
    (b) => b.includes("Happy Hour") && !b.includes("Bottomless Brunch"),
  );
  assert.ok(hhCards.length > 0, "expected Happy Hour card");
  const hhHtml = hhCards.join("");
  assert.match(hhHtml, /href="https:\/\/www\.mamasonthehalfshell\.com\/"/);
  assert.doesNotMatch(hhHtml, /href="https:\/\/www\.instagram\.com\/mamasonthehalfshell\/"/);
});

test("Claddagh is verified with a full weekly board and dine-in-only on the three steaks", async () => {
  const claddagh = (await loadVenues()).find((v) => v.id === "claddagh-pub");
  assert.equal(claddagh.status, "verified");
  assert.equal(claddagh.source_type, "venue_website");
  assert.equal(claddagh.address, "2918 O'Donnell St, Baltimore, MD 21224");
  assert.ok(claddagh.deals.length >= 14, `expected full week, got ${claddagh.deals.length}`);
  assert.deepEqual(venueShapeErrors(claddagh), []);

  const dineIn = claddagh.deals
    .flatMap((d) => d.items)
    .filter((i) => /dine-in only/i.test(i.text))
    .map((i) => i.text);
  assert.equal(dineIn.length, 3);
  assert.ok(dineIn.some((t) => /New York Strip/i.test(t)));
  assert.ok(dineIn.some((t) => /Filet/i.test(t)));
  assert.ok(dineIn.some((t) => /Crab Cakes/i.test(t)));

  // Two Sunday blocks, kept separate.
  const sun = claddagh.deals.filter((d) => d.days.includes("sun"));
  assert.ok(sun.some((d) => d.items.some((i) => i.text === "Sunday Specials")));
  assert.ok(sun.some((d) => d.items.some((i) => i.text === "Sunday Sports Specials")));

  // BAR ONLY is published on the happy-hour page, not weekly-specials.
  const hh = claddagh.deals.filter((d) =>
    d.items.some((i) => i.text === "Happy Hour (bar only)"),
  );
  assert.equal(hh.length, 5);
  for (const deal of hh) {
    assert.equal(deal.source_url, "https://claddaghbaltimore.com/menus/happy-hour/");
  }
  const nonHh = claddagh.deals.filter(
    (d) => !d.items.some((i) => i.text === "Happy Hour (bar only)"),
  );
  for (const deal of nonHh) {
    assert.equal(deal.source_url, "https://claddaghbaltimore.com/weekly-specials/");
  }

  const html = await boardFor(new Date("2026-08-03T20:00:00Z")); // Monday
  assert.match(html, /Claddagh Pub/);
  assert.match(html, /dine-in only/);
  assert.match(html, /claddaghbaltimore\.com\/menus\/happy-hour\//);
  assert.match(html, /claddaghbaltimore\.com\/weekly-specials\//);
});

test("no-deal venues carry a reason and never an offer", async () => {
  const ids = [
    "walts-inn",
    "bo-brooks",
    "sports-balls",
    "baltimore-tap-house",
    "the-worthington",
    "sopro",
    "honeypot",
  ];
  const venues = await loadVenues();
  for (const id of ids) {
    const v = venues.find((row) => row.id === id);
    assert.ok(v, `${id} missing`);
    assert.equal(v.status, "open_unverifiable");
    assert.deepEqual(v.deals, []);
    assert.ok(v.notes_public, `${id} needs a public reason`);
    assert.deepEqual(venueShapeErrors(v), []);
  }
});

test("Stackhouse still has times-only happy hour — no 2019 food prices", async () => {
  const stack = (await loadVenues()).find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stack.deals.every((d) => d.prices_published === false));
  const texts = stack.deals.flatMap((d) => d.items.map((i) => i.text)).join(" ");
  assert.doesNotMatch(texts, /Wing Night|Burger Night|Seafood Night|\$10|\$8|\$15\.99/);
  assert.match(stack.ops_notes ?? "", /2019/);
});

// --- no-deal collapsed group ----------------------------------------------

test("the no-deal group lists the seven bars, Lee's, and El Bufalo — name + reason only", async () => {
  const venues = venuesInView(await loadVenues(), CANTON);
  const quiet = noDealVenues(venues);
  const ids = quiet.map((v) => v.id).sort();

  assert.deepEqual(ids, [
    "baltimore-tap-house",
    "bo-brooks",
    "el-bufalo",
    "honeypot",
    "lees-pint-and-shell",
    "sopro",
    "sports-balls",
    "the-worthington",
    "walts-inn",
  ]);

  const html = await boardFor(FRI_11PM_EDT);
  assert.match(html, /9 more spots, no deals we can show/);
  assert.match(html, /<details>/);
  assert.match(html, /class="quiet"/);

  for (const v of quiet) {
    assert.ok(html.includes(escapeHtml(v.name)), `${v.id} missing from quiet group`);
    assert.ok(v.notes_public, `${v.id} needs a public reason`);
    assert.ok(html.includes(escapeHtml(v.notes_public)), `${v.id} reason missing`);
    // Never a deal card for these.
    assert.ok(!html.includes(`<h3>${escapeHtml(v.name)}`), `${v.id} leaked a deal card`);
  }

  // Held offer text must never appear for El Bufalo.
  assert.doesNotMatch(html, /16oz Modelo Especial/);
  // Lee's reason names the blocker, not the promo.
  assert.match(html, /monthly promo as an image we cannot read/i);
  assert.doesNotMatch(html, /Build-your-own-burger/i);
  assert.doesNotMatch(html, /first Wednesday/i);
});

test("Lee's notes_public is a reason, not an offer", async () => {
  const lees = (await loadVenues()).find((v) => v.id === "lees-pint-and-shell");
  assert.match(lees.notes_public, /image we cannot read/i);
  assert.doesNotMatch(lees.notes_public, /Build-your-own-burger|first Wednesday/i);
});
