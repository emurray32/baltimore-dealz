import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BALTIMORE_TZ,
  WEEK,
  dayKeyInZone,
  dealsForDay,
  distanceMeters,
  EARTH_RADIUS_M,
  FOOD_CATEGORIES,
  dealTiming,
  hasEnded,
  minutesNowInZone,
  hasShowableDeal,
  isDealRenderable,
  isRenderable,
  isVerifiedDateStale,
  noDealVenues,
  STALE_AFTER_DAYS,
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
  assert.match(friday, /<p class="meta">Friday<\/p>/);
  assert.match(saturday, /<p class="meta">Saturday<\/p>/);
  assert.doesNotMatch(friday, /Baltimore time/);
  assert.doesNotMatch(saturday, /Baltimore time/);

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
  // Pin WHO is quiet, not only how many — stubs from the 2026-08-06 expansion load
  // join the original no-deal group without inventing prices.
  assert.deepEqual(
    unverified.map((v) => v.id).sort(),
    [
      "admirals-cup",
      "baltimore-tap-house",
      "bark-social-canton",
      "barracudas-locust-point",
      "blackwall-hitch",
      "bo-brooks",
      "cross-street-market",
      "crossbar",
      "gameon-bar-arcade",
      "honeypot",
      "kislings-tavern",
      "lees-pint-and-shell",
      "limoncello",
      "locals-only",
      "market-ale-house",
      "maxs-taphouse",
      "mobtown-brewing",
      "peters-pour-house",
      "pub-dog-fed-hill",
      "rye-of-baltimore",
      "sopro",
      "sports-balls",
      "stuggys",
      "the-outpost",
      "the-point-in-fells",
      "the-worthington",
      "walts-inn",
      "watershed",
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
  // Name may be plain in <h3> or wrapped in <a class="venue-link">…</a>.
  const escaped = escapeHtml(venueName);
  return html
    .split("<article")
    .filter(
      (block) =>
        block.includes(`<h3>${escaped}`) ||
        block.includes(`>${escaped}</a>`),
    );
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

  // Held-only = zero showable: still in venues.json, off the board (Eric rule).
  const html = await boardFor(new Date("2026-08-08T20:00:00Z")); // a Saturday
  assert.ok(!html.includes(`<h3>${escapeHtml(elBufalo.name)}`), "El Bufalo has a deal card");
  assert.ok(!html.includes(escapeHtml(elBufalo.name)), "held-only name must not list on board");
  for (const item of elBufalo.deals.flatMap((d) => d.items.map((i) => i.text))) {
    assert.ok(!html.includes(escapeHtml(item)), `held item "${item}" rendered`);
  }
  assert.doesNotMatch(html, /class="quiet"/);
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
  // No middle-dot separators between chips — they orphan onto their own line
  // when the switcher wraps at phone width. Spacing is CSS gap.
  const nav = paired.match(/<nav class="meta">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.doesNotMatch(nav, / · /);
});

test("views.json has a usable default view", async () => {
  const views = await loadViews();
  assert.ok(views.length > 0);

  const fallback = defaultView(views);
  assert.equal(typeof fallback.slug, "string");
  assert.equal(findView(views, fallback.slug), fallback);
  assert.equal(findView(views, "no-such-view"), undefined);
  // City-wide is first so / lands on Tonight in Baltimore without hardcoding
  // the slug in server.js / static build.
  assert.equal(fallback.slug, "baltimore");
  assert.equal(fallback.neighborhoods, "*");

  for (const view of views) {
    if (view.neighborhoods === "*") {
      assert.equal(typeof view.label, "string");
      continue;
    }
    assert.ok(Array.isArray(view.neighborhoods) && view.neighborhoods.length > 0);
    assert.equal(typeof view.label, "string");
  }
});

test("city-wide view includes every venue once (not a neighbourhood list)", async () => {
  const views = await loadViews();
  const city = findView(views, "baltimore");
  assert.ok(city);
  assert.equal(city.neighborhoods, "*");
  assert.equal(city.label, "Baltimore");

  const venues = await loadVenues();
  const inCity = venuesInView(venues, city);
  assert.equal(inCity.length, venues.length);
  // Same objects, same order — no duplication when a venue could match many boards.
  assert.deepEqual(
    inCity.map((v) => v.id),
    venues.map((v) => v.id),
  );

  // Switcher lists Baltimore first, then the neighbourhood boards.
  assert.equal(views[0].slug, "baltimore");
  assert.ok(views.some((v) => v.slug === "canton"));
});

test("every venue's neighborhood belongs to some view", async () => {
  // Only neighbourhood lists count — "*" is not a neighbourhood name.
  const covered = new Set(
    (await loadViews())
      .filter((view) => Array.isArray(view.neighborhoods))
      .flatMap((view) => view.neighborhoods),
  );
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
  // Zero-deal venues stay off the board entirely (Eric rule 2026-08-07).
  assert.doesNotMatch(html, /Hidden Bar/);
  assert.doesNotMatch(html, /No specials we can verify/);
  assert.doesNotMatch(html, /class="quiet"/);
  // Control: the showable seed venue still renders.
  assert.match(html, /Test Venue|Huck|article class="card"/);
});

test("neighborhood labels come from the city boundary layer, with provenance", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  // Both of these read the other way round before the city's point-in-polygon
  // check; the seed venue was the Brewers Hill one all along.
  assert.equal(byId["hucks-american-craft"].neighborhood, "Brewers Hill");
  assert.equal(byId["union-hill-kitchen"].neighborhood, "Canton");

  assert.deepEqual(
    venues.filter((v) => v.neighborhood === "Brewers Hill").map((v) => v.id).sort(),
    ["hucks-american-craft", "mobtown-brewing"].sort(),
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


test("dealTiming: finished vs on now vs starts later; end:null never finished", () => {
  // Lead pin: deal ending at 18:00 is finished at 18:30 and on now at 17:30.
  const timed = { start: 15 * 60, end: 18 * 60 }; // 3pm–6pm
  assert.equal(dealTiming(timed, 17 * 60 + 30), "on_now");
  assert.equal(dealTiming(timed, 18 * 60), "finished");
  assert.equal(dealTiming(timed, 18 * 60 + 30), "finished");
  assert.equal(dealTiming(timed, 14 * 60), "starts_later");

  // end:null can never be finished at any minute of the day.
  const openEnded = { start: 23 * 60, end: null };
  for (let m = 0; m < 1440; m += 37) {
    assert.notEqual(dealTiming(openEnded, m), "finished");
  }
  assert.equal(dealTiming(openEnded, 22 * 60), "starts_later");
  assert.equal(dealTiming(openEnded, 23 * 60 + 1), "on_now");

  // Untimed / all-day — no meaningful window → on now, never invent start.
  assert.equal(dealTiming({ start: null, end: null }, 12 * 60), "on_now");
  assert.equal(dealTiming({ start: undefined, end: undefined }, 3 * 60), "on_now");
});

test("minutesNowInZone reads Baltimore, not a hard-coded offset", () => {
  // Fri Aug 7 2026 11pm EDT = 23:00 in Baltimore → 1380 minutes.
  const fri11 = new Date("2026-08-08T03:00:00Z");
  assert.equal(minutesNowInZone(fri11), 23 * 60);
  // Same UTC instant is not 23:00 in UTC itself.
  assert.notEqual(fri11.getUTCHours() * 60 + fri11.getUTCMinutes(), 23 * 60);
});

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
  // Good-to-know only lists notes for venues that still have a showable deal.
  const withPublic = venues.filter((v) => v.notes_public && hasShowableDeal(v));

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
  assert.match(raw.derived_from, /CANTON_DEALS\.md as of 2026-08-05.*sha256 [a-f0-9]{64}/);
  assert.match(raw.derived_from, /§8f food_categories/);
  assert.equal(raw.schema_version, 7);
});

// --- coordinates + per-deal source URL ------------------------------------

test("coordinates carry OSM provenance and cover every researched row except Sports Balls", async () => {
  const venues = await loadVenues();
  const withCoords = venues.filter((v) => v.lat !== undefined);
  const without = venues.filter((v) => v.lat === undefined).map((v) => v.id);

  // Sports Balls is the only researched row without a pin; every other venue
  // (including the 2026-08-06 expansion) carries Nominatim coords.
  assert.equal(withCoords.length, venues.length - 1);
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
  const openUnverifiable = [
    "walts-inn",
    "bo-brooks",
    "sports-balls",
    "the-worthington",
    "sopro",
    "honeypot",
  ];
  const venues = await loadVenues();
  for (const id of openUnverifiable) {
    const v = venues.find((row) => row.id === id);
    assert.ok(v, `${id} missing`);
    assert.equal(v.status, "open_unverifiable");
    assert.deepEqual(v.deals, []);
    assert.ok(v.notes_public, `${id} needs a public reason`);
    assert.deepEqual(venueShapeErrors(v), []);
  }
  // Tap House is neither open nor closed supportably — unconfirmed, not open_unverifiable.
  const tap = venues.find((row) => row.id === "baltimore-tap-house");
  assert.ok(tap);
  assert.equal(tap.status, "unconfirmed");
  assert.deepEqual(tap.deals, []);
  assert.match(tap.notes_public, /unconfirmed/i);
  assert.deepEqual(venueShapeErrors(tap), []);
  assert.equal(isRenderable(tap), false);
});

test("Stackhouse still has times-only happy hour — no 2019 food prices", async () => {
  const stack = (await loadVenues()).find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stack.deals.every((d) => d.prices_published === false));
  const texts = stack.deals.flatMap((d) => d.items.map((i) => i.text)).join(" ");
  assert.doesNotMatch(texts, /Wing Night|Burger Night|Seafood Night|\$10|\$8|\$15\.99/);
  assert.match(stack.ops_notes ?? "", /2019/);
});

// Vague happy-hour audit (CoS item 4, 2026-08-06): Union Hill was the only
// lag — real $2-off / half-off list to 6:30pm. Block A under HAPPY HOUR only;
// do not ship Block B's broader "WINE" / missing seltzers wording.
test("Union Hill happy hour ships Block A through 6:30pm", async () => {
  const uh = (await loadVenues()).find((v) => v.id === "union-hill-kitchen");
  assert.ok(uh);
  assert.equal(uh.deals.length, 1);
  const d = uh.deals[0];
  assert.equal(d.start, 900);
  assert.equal(d.end, 1110);
  assert.equal(d.time_window, "3pm-6:30pm");
  assert.equal(d.prices_published, undefined);
  assert.deepEqual(
    d.items.map((i) => i.text),
    [
      "$2 OFF small plates and flatbreads",
      "$2 OFF all cocktails",
      "$2 OFF all wines by the glass",
      "$2 OFF draft and bottled beers, seltzers and ciders",
      "1/2 OFF raw oysters",
    ],
  );
  const joined = d.items.map((i) => i.text).join(" ");
  assert.doesNotMatch(joined, /craft cocktails|ALL COCKTAILS, WINE|1\/2 PRICED/i);
});

// The other nine vague rows (or already-held ones) must say so on the card —
// not look like we forgot the prices.
test("vague happy-hour rows without prices carry prices_published:false", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  const mustFlag = [
    byId["mamas-on-the-half-shell"].deals.find((d) => d.time_window === "3pm-6pm"),
    byId["mamas-on-the-half-shell"].deals.find((d) => d.status === "held"),
    ...byId["hudson-street-stackhouse"].deals,
    byId["the-dive"].deals.find((d) => d.time_window === "4pm-6pm"),
    byId.smaltimore.deals.find((d) => d.time_window === "all night"),
    byId.smaltimore.deals.find((d) => d.time_window === "10am-1pm"),
    byId["mahaffeys-pub"].deals.find((d) => d.items.some((i) => i.text === "Sliders")),
  ];
  assert.equal(mustFlag.length, 9);
  for (const deal of mustFlag) {
    assert.ok(deal, "expected a vague happy-hour row");
    assert.equal(deal.prices_published, false);
  }
});

// --- zero-deal venues off the board (Eric rule 2026-08-07) ----------------

test("zero-deal and held-only venues stay in data but off the board and map section", async () => {
  const venues = venuesInView(await loadVenues(), CANTON);
  const quiet = noDealVenues(venues);
  const ids = quiet.map((v) => v.id).sort();

  // Still in venues.json (helper still finds them) — render change, not delete.
  assert.deepEqual(ids, [
    "baltimore-tap-house",
    "bark-social-canton",
    "bo-brooks",
    "el-bufalo",
    "honeypot",
    "kislings-tavern",
    "lees-pint-and-shell",
    "mobtown-brewing",
    "sopro",
    "sports-balls",
    "the-worthington",
    "walts-inn",
  ]);

  const html = await boardFor(FRI_11PM_EDT);
  assert.doesNotMatch(html, /more spots, no deals we can show/);
  assert.doesNotMatch(html, /class="quiet"/);
  assert.doesNotMatch(html, /quiet-list/);

  for (const v of quiet) {
    assert.ok(v.notes_public, `${v.id} needs a public reason (venue page / research)`);
    // Not listed on the board at all — name, reason, or deal card.
    assert.ok(!html.includes(escapeHtml(v.name)), `${v.id} still listed on board`);
    assert.ok(!html.includes(`<h3>${escapeHtml(v.name)}`), `${v.id} leaked a deal card`);
  }

  // Held offer text must never appear for El Bufalo.
  assert.doesNotMatch(html, /16oz Modelo Especial/);
  // Lee's reason (and inventable promo text) must not appear on the board.
  assert.doesNotMatch(html, /monthly promo as an image we cannot read/i);
  assert.doesNotMatch(html, /Build-your-own-burger/i);
  assert.doesNotMatch(html, /first Wednesday/i);

  // Board still has showable Canton/Brewers Hill deal venues.
  assert.match(html, /Huck|Claddagh|Mama|Mahaffey|article class="card"/);
});

test("Lee's notes_public is a reason, not an offer", async () => {
  const lees = (await loadVenues()).find((v) => v.id === "lees-pint-and-shell");
  assert.match(lees.notes_public, /image we cannot read/i);
  assert.doesNotMatch(lees.notes_public, /Build-your-own-burger|first Wednesday/i);
});

// --- happy_hour + verified_date (optional deal fields) --------------------

test("optional happy_hour and verified_date are valid; bad shapes fail", () => {
  assert.deepEqual(
    venueShapeErrors(
      venue({
        deals: [
          {
            days: ["mon"],
            items: [{ text: "$3 beer" }],
            start: null,
            end: null,
            happy_hour: true,
            verified_date: "2026-08-03",
          },
        ],
      }),
    ),
    [],
  );
  // Untagged deal stays valid (fields are optional).
  assert.deepEqual(
    venueShapeErrors(
      venue({
        deals: [{ days: ["mon"], items: [{ text: "$1 beer" }], start: null, end: null }],
      }),
    ),
    [],
  );
  // happy_hour must be a boolean when present.
  const badBool = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["mon"],
          items: [{ text: "x" }],
          start: null,
          end: null,
          happy_hour: "yes",
        },
      ],
    }),
  );
  assert.ok(badBool.some((e) => e.includes("happy_hour must be a boolean")), badBool.join("; "));
  // verified_date must be YYYY-MM-DD.
  for (const bad of ["8/3/2026", "2026-8-03", "", "yesterday", 20260803]) {
    const errors = venueShapeErrors(
      venue({
        deals: [
          {
            days: ["mon"],
            items: [{ text: "x" }],
            start: null,
            end: null,
            verified_date: bad,
          },
        ],
      }),
    );
    assert.ok(
      errors.some((e) => e.includes("verified_date must be YYYY-MM-DD")),
      `verified_date ${JSON.stringify(bad)} was accepted`,
    );
  }
});

test("unknown deal keys still fail validation after happy_hour landed", () => {
  const errors = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["mon"],
          items: [{ text: "x" }],
          start: null,
          end: null,
          happy_hour: true,
          stale: true,
        },
      ],
    }),
  );
  assert.ok(errors.some((e) => e.includes('unknown field "stale"')), errors.join("; "));
});

test("isVerifiedDateStale flags dates older than 30 whole days", () => {
  assert.equal(STALE_AFTER_DAYS, 30);
  // Fixed "now" so the suite does not depend on the machine clock.
  const now = new Date("2026-09-03T16:00:00Z"); // UTC 2026-09-03
  // Exactly 30 days earlier is still fresh; 31 is stale.
  assert.equal(isVerifiedDateStale("2026-08-04", now), false); // 30 days
  assert.equal(isVerifiedDateStale("2026-08-03", now), true); // 31 days
  assert.equal(isVerifiedDateStale("2026-09-03", now), false); // today
  assert.equal(isVerifiedDateStale("2026-09-04", now), false); // future
  // Malformed / missing are not "stale" — validation owns those.
  assert.equal(isVerifiedDateStale(undefined, now), false);
  assert.equal(isVerifiedDateStale("not-a-date", now), false);
});

test("a Happy Hour deal renders the chip and verified date on the board", () => {
  const v = venue({
    name: "HH Bar",
    deals: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        items: [{ text: "$3 rail" }],
        start: 960,
        end: 1140,
        time_window: "4pm-7pm",
        happy_hour: true,
        verified_date: "2026-08-03",
      },
    ],
  });
  const html = renderBoard([v], CANTON, [CANTON], FRI_11PM_EDT);
  assert.match(html, /class="chip">Happy Hour<\/span>/);
  assert.match(html, /class="chip">verified 2026-08-03<\/span>/);
  assert.doesNotMatch(html, /stale/);
});

test("a deal older than 30 days is flagged stale on the board", () => {
  const v = venue({
    name: "Stale Bar",
    deals: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        items: [{ text: "$2 domestic" }],
        start: null,
        end: null,
        happy_hour: true,
        verified_date: "2026-01-01",
      },
    ],
  });
  // Board "now" is Fri 11pm EDT Aug 7 2026 — Jan 1 is far past 30 days.
  const html = renderBoard([v], CANTON, [CANTON], FRI_11PM_EDT);
  assert.match(html, /chip-stale/);
  assert.match(html, /verified 2026-01-01 · stale/);
});

test("seed happy-hour tags match Deal Scout: confirmed get dates; disputed omit them", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  // Confirmed with a date (Deal Scout §8).
  const silksHh = byId.silks.deals.find((d) => d.happy_hour);
  assert.equal(silksHh.happy_hour, true);
  assert.equal(silksHh.verified_date, "2026-08-03");

  const claddaghHh = byId["claddagh-pub"].deals.filter((d) => d.happy_hour);
  assert.ok(claddaghHh.length >= 5);
  for (const d of claddaghHh) {
    assert.equal(d.verified_date, "2026-08-05");
  }

  // Happy hour is real but time/days disputed — label only, no verified_date.
  const goodVibesHeld = byId["good-vibes-cantina"].deals.find((d) => d.status === "held");
  assert.equal(goodVibesHeld.happy_hour, true);
  assert.equal(goodVibesHeld.verified_date, undefined);

  const elBufaloHeld = byId["el-bufalo"].deals.find((d) => d.status === "held");
  assert.equal(elBufaloHeld.happy_hour, true);
  assert.equal(elBufaloHeld.verified_date, undefined);

  // Cowboy Row is NOT VERIFIED as a happy hour — never tag it.
  assert.ok(byId["cowboy-row"].deals.every((d) => d.happy_hour !== true));

  // A real seed board shows the chip on Silks.
  const html = await boardFor(new Date("2026-08-03T20:00:00Z")); // Monday
  const silksCards = cardsFor(html, "Silks");
  assert.ok(silksCards.length > 0, "expected Silks card on Monday");
  assert.match(silksCards.join(""), /class="chip">Happy Hour<\/span>/);
  assert.match(silksCards.join(""), /verified 2026-08-03/);
});

test("unconfirmed is a legal venue status and never renders deal cards", () => {
  const v = venue({
    id: "maybe-open",
    name: "Maybe Open Pub",
    status: "unconfirmed",
    deals: [],
    source_type: undefined,
    last_verified: undefined,
  });
  assert.deepEqual(venueShapeErrors(v), []);
  assert.equal(isRenderable(v), false);
  assert.deepEqual(dealsForDay([v], "mon"), []);
});

test("deep source URLs land on Huck's, Stackhouse, and Mahaffey's", async () => {
  const venues = await loadVenues();
  const hucks = venues.find((v) => v.id === "hucks-american-craft");
  const stack = venues.find((v) => v.id === "hudson-street-stackhouse");
  const maha = venues.find((v) => v.id === "mahaffeys-pub");
  assert.equal(hucks.source_url, "https://www.hucksamericancraft.com/#dailyspecials-section");
  // Stackhouse homepage carries the HH windows; /weekly-food-specials/ is 2019 dinner
  // specials and does not publish those times (Lead 2026-08-06).
  assert.equal(stack.source_url, "https://hudsonstreetstackhouse.com/");
  assert.match(maha.source_url, /getbento\.com.*Weekly%20Specials\.pdf/);
});

test("no venue source_url points at Stackhouse /weekly-food-specials/", async () => {
  // Eric found the board saying "prices not published" while linking a page of
  // 2019 dinner prices that also lacks the happy-hour times we quote.
  const venues = await loadVenues();
  for (const v of venues) {
    assert.doesNotMatch(
      v.source_url ?? "",
      /weekly-food-specials/i,
      `${v.id} venue source_url`,
    );
    for (const d of v.deals ?? []) {
      assert.doesNotMatch(
        d.source_url ?? "",
        /weekly-food-specials/i,
        `${v.id} deal source_url`,
      );
    }
  }
  const stack = venues.find((v) => v.id === "hudson-street-stackhouse");
  assert.equal(stack.source_url, "https://hudsonstreetstackhouse.com/");
  assert.ok(stack.deals.every((d) => d.prices_published === false));
  assert.match(stack.ops_notes ?? "", /wrong source for happy hour|homepage/i);
});



// --- 2026-08-06 expansion: 4 priced + quiet stubs + two views -------------

test("expansion load: four priced venues and two new views", async () => {
  const views = await loadViews();
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));
  assert.deepEqual(bySlug["inner-harbor"].neighborhoods, [
    "Inner Harbor",
    "Harbor East",
    "Downtown",
  ]);
  assert.deepEqual(bySlug["locust-point"].neighborhoods, ["Locust Point", "Riverside"]);

  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  // Loch Bar — Harbor East, Mon–Fri HH from PDF (pdftotext of live source_url).
  const loch = byId["loch-bar"];
  assert.equal(loch.status, "verified");
  assert.equal(loch.neighborhood, "Harbor East");
  assert.match(loch.source_url, /LochBar_HH/);
  assert.equal(loch.deals.length, 1);
  assert.equal(loch.deals[0].start, 900);
  assert.equal(loch.deals[0].end, 1080);
  const lochText = loch.deals[0].items.map((i) => i.text).join(" | ");
  assert.match(lochText, /\$2\.50/);
  assert.match(lochText, /Hushpuppies \$5/);
  assert.match(lochText, /Fried Oysters \(2\) \$6/);
  assert.match(lochText, /Petit Charcuterie Board \$12/);
  assert.match(lochText, /Wine \$7/);
  assert.match(lochText, /Draft Beer \$6/);
  assert.match(lochText, /Cocktails \$8/);
  assert.match(lochText, /Crushes \$8/);
  assert.match(lochText, /Slushies \$10/);
  // Research-sample phantoms / wrong $ must not reappear.
  assert.doesNotMatch(lochText, /Clams Casino|Seafood Chili|Truffle Parmesan|Cocktails\/Crushes \$9|Frosé \$12|Fried Oysters \$9[^.]/);

  // Copper Shark — Riverside honesty, two HH windows.
  const cs = byId["copper-shark"];
  assert.equal(cs.neighborhood, "Riverside");
  assert.equal(cs.deals.length, 2);
  const mon = cs.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const mid = cs.deals.find((d) => d.days.includes("tue"));
  assert.equal(mon.end, 1320);
  assert.equal(mid.end, 1140);
  assert.ok(cs.deals.every((d) => d.items.some((i) => /\$8/.test(i.text))));

  // Tagliata — bar only, no Saturday.
  const tag = byId["tagliata"];
  assert.equal(tag.deals[0].time_window, "4pm-6pm (bar only)");
  assert.ok(!tag.deals[0].days.includes("sat"));
  assert.ok(tag.deals[0].items.some((i) => /Wine \$6/.test(i.text)));

  // HomeSlyce Canton — HH + weekly pizza specials; no invented IG prices.
  const hs = byId["homeslyce-canton"];
  assert.equal(hs.neighborhood, "Canton");
  const hh = hs.deals.find((d) => d.happy_hour === true);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.ok(hh.items.some((i) => /\$3 OFF/.test(i.text)));
  assert.deepEqual(hh.food_categories, ["drink", "wings"]);
  assert.ok(!hh.food_categories.includes("pizza"), "pizza is weekly specials, not HH");
  assert.ok(hs.deals.some((d) => d.days.includes("mon") && !d.happy_hour));

  // Wayward / Azumi / M8 never invented onto the board.
  for (const id of ["wayward", "m8-beer", "azumi"]) {
    assert.equal(byId[id], undefined, id);
  }

  // Views surface the priced rows.
  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "loch-bar"));
  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "tagliata"));
  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "copper-shark"));
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "homeslyce-canton"));
});

test("expansion quiet stubs never invent happy-hour prices", async () => {
  const venues = await loadVenues();
  const stubIds = [
    "maxs-taphouse",
    "admirals-cup",
    "stuggys",
    "blackwall-hitch",
    "barracudas-locust-point",
    "bark-social-canton",
  ];
  for (const id of stubIds) {
    const v = venues.find((x) => x.id === id);
    assert.ok(v, id);
    assert.equal(v.status, "open_unverifiable", id);
    assert.equal(v.deals.length, 0, id);
    assert.ok((v.notes_public || "").length > 0, id);
  }
});

test("Loch Bar HH items match the live PDF at source_url (pdftotext pins)", async () => {
  // Reviewer 2026-08-06: research sample had wrong $ and phantom dishes.
  // Pin against the PDF text extracted from the exact source_url.
  const loch = (await loadVenues()).find((v) => v.id === "loch-bar");
  assert.equal(
    loch.source_url,
    "https://lochbar.com/wp-content/uploads/2025/09/LochBar_HH_8.30.25.pdf",
  );
  const texts = loch.deals[0].items.map((i) => i.text);
  const joined = texts.join("\n");

  // Correct prices from PDF.
  assert.ok(texts.some((t) => /Local Oysters.*\$2\.50/.test(t)));
  assert.ok(texts.some((t) => /Buttermilk Hushpuppies \$5/.test(t)));
  assert.ok(texts.some((t) => /Old Bay French Fries \$5/.test(t)));
  assert.ok(texts.some((t) => /Fried Oysters \(2\) \$6/.test(t)));
  assert.ok(texts.some((t) => /Maryland Crab Soup \$6/.test(t)));
  assert.ok(texts.some((t) => /Cream of Crab Soup \$6/.test(t)));
  assert.ok(texts.some((t) => /Petit Charcuterie Board \$12/.test(t)));
  assert.ok(texts.some((t) => /Wine \$7/.test(t)));
  assert.ok(texts.some((t) => /Draft Beer \$6/.test(t)));
  assert.ok(texts.some((t) => /Cocktails \$8/.test(t)));
  assert.ok(texts.some((t) => /Crushes \$8/.test(t)));
  assert.ok(texts.some((t) => /Slushies \$10/.test(t)));

  // Wrong research sample — must not ship.
  assert.doesNotMatch(joined, /Clams Casino/);
  assert.doesNotMatch(joined, /Seafood Chili/);
  assert.doesNotMatch(joined, /Truffle Parmesan/);
  assert.doesNotMatch(joined, /Cocktails\/Crushes \$9/);
  assert.doesNotMatch(joined, /Fried Oysters \$9/);
  assert.doesNotMatch(joined, /Charcuterie Board \$14/);
  assert.doesNotMatch(joined, /Frosé \$12/);
});

// --- nearest-first: the served page must actually carry the feature ---------
//
// These exist because of a real miss: the script was defined but never
// interpolated into renderBoard, and the button was hidden with nothing to
// reveal it — while the suite sat green at 54/54 because nothing looked. A
// passing count that never grows is not evidence; these pin the artifact.

test("distanceMeters matches a known great-circle answer", () => {
  // One degree of longitude at the equator is a quarter meridian / 90.
  const oneDegree = distanceMeters(0, 0, 0, 1);
  assert.ok(Math.abs(oneDegree - (EARTH_RADIUS_M * Math.PI) / 180) < 0.5, `got ${oneDegree}`);
  // Same point is zero, and antipodal points are half the circumference.
  assert.equal(distanceMeters(39.28, -76.57, 39.28, -76.57), 0);
  const antipodal = distanceMeters(0, 0, 0, 180);
  assert.ok(Math.abs(antipodal - Math.PI * EARTH_RADIUS_M) < 1, `got ${antipodal}`);
});

test("the served page actually ships the nearest-first script", async () => {
  const html = await boardFor(FRI_11PM_EDT);
  // The script reaches the browser, before </body>, exactly once.
  assert.equal((html.match(/<script>/g) || []).length, 1, "expected one inline script");
  assert.match(html, /getCurrentPosition/);
  assert.ok(html.indexOf("getCurrentPosition") < html.indexOf("</body>"), "script is not before </body>");
});

test("the nearest button is present, default-hidden, and revealed only where geolocation exists", async () => {
  const html = await boardFor(FRI_11PM_EDT);
  // Default-hidden markup: no location is requested, and nothing shows, until
  // the script confirms geolocation exists and the customer taps.
  assert.match(html, /<button[^>]*id="nearest-btn"[^>]*hidden/);
  // The script holds both branches: reveal where geolocation exists, keep
  // hidden where it does not. Both lines must ship.
  assert.match(html, /btn\.hidden = false/);
  assert.match(html, /btn\.hidden = true/);
  // And the reveal is gated on the capability check, not unconditional.
  assert.match(html, /"geolocation" in navigator/);
});

// --- food_categories (optional deal-level array, Deal Scout §8f/§8g) --------

test("optional food_categories is valid; unknown values and bad shapes fail", () => {
  // Valid single-element array.
  assert.deepEqual(
    venueShapeErrors(
      venue({
        deals: [
          {
            days: ["mon"],
            items: [{ text: "$10 wings" }],
            start: null,
            end: null,
            food_categories: ["wings"],
          },
        ],
      }),
    ),
    [],
  );
  // Valid multi-category array (the Claddagh Sat shape).
  assert.deepEqual(
    venueShapeErrors(
      venue({
        deals: [
          {
            days: ["sat"],
            items: [{ text: "30 Wings $28" }, { text: "Cheesesteaks $8" }],
            start: null,
            end: null,
            food_categories: ["wings", "sandwich/cheesesteak"],
          },
        ],
      }),
    ),
    [],
  );
  // Untagged row stays valid (field is optional).
  assert.deepEqual(
    venueShapeErrors(
      venue({
        deals: [{ days: ["mon"], items: [{ text: "$1 beer" }], start: null, end: null }],
      }),
    ),
    [],
  );
  // Unknown category rejected.
  const unknown = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["mon"],
          items: [{ text: "x" }],
          start: null,
          end: null,
          food_categories: ["wings", "ramen"],
        },
      ],
    }),
  );
  assert.ok(
    unknown.some((e) => e.includes('food_categories value "ramen"')),
    unknown.join("; "),
  );
  // String (the retired single-value shape) rejected — must be an array.
  const asString = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["mon"],
          items: [{ text: "x" }],
          start: null,
          end: null,
          food_categories: "wings",
        },
      ],
    }),
  );
  assert.ok(
    asString.some((e) => e.includes("food_categories must be a non-empty array")),
    asString.join("; "),
  );
  // Empty array rejected.
  const empty = venueShapeErrors(
    venue({
      deals: [
        {
          days: ["mon"],
          items: [{ text: "x" }],
          start: null,
          end: null,
          food_categories: [],
        },
      ],
    }),
  );
  assert.ok(
    empty.some((e) => e.includes("food_categories must be a non-empty array")),
    empty.join("; "),
  );
  // Every controlled-vocab value is accepted alone.
  for (const cat of FOOD_CATEGORIES) {
    const errors = venueShapeErrors(
      venue({
        deals: [
          {
            days: ["mon"],
            items: [{ text: "x" }],
            start: null,
            end: null,
            food_categories: [cat],
          },
        ],
      }),
    );
    assert.deepEqual(errors, [], `category ${cat} was rejected`);
  }
});

test("a multi-category deal renders one chip per category", () => {
  const v = venue({
    name: "Claddagh Pub",
    deals: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        items: [{ text: "30 Wings $28" }, { text: "Cheesesteaks $8" }],
        start: null,
        end: null,
        food_categories: ["wings", "sandwich/cheesesteak"],
      },
    ],
  });
  const html = renderBoard([v], CANTON, [CANTON], FRI_11PM_EDT);
  assert.match(html, /class="chip">Wings<\/span>/);
  assert.match(html, /class="chip">Sandwich<\/span>/);
});

test("an untagged deal renders no food-category chip", () => {
  const v = venue({
    name: "Plain Bar",
    deals: [
      {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        items: [{ text: "$1 beer" }],
        start: null,
        end: null,
      },
    ],
  });
  const html = renderBoard([v], CANTON, [CANTON], FRI_11PM_EDT);
  assert.doesNotMatch(html, /class="chip">Wings<\/span>/);
  assert.doesNotMatch(html, /class="chip">Drink<\/span>/);
  assert.doesNotMatch(html, /class="chip">Burger<\/span>/);
});

test("seed food_categories: every deal tagged; Claddagh multi-rows still pinned", async () => {
  const venues = await loadVenues();
  const deals = venues.flatMap((v) => v.deals.map((d) => ({ venue: v, deal: d })));
  // Expansion added priced rows; pin that the board grew past the original 87, not a brittle total.
  assert.ok(deals.length >= 87, `expected at least 87 deal rows, got ${deals.length}`);

  // Every seed row carries the field (optional in schema; filled in seed).
  for (const { venue, deal } of deals) {
    assert.ok(
      Array.isArray(deal.food_categories) && deal.food_categories.length > 0,
      `${venue.id}: missing food_categories on ${deal.items[0].text}`,
    );
  }

  // Claddagh Sat + Wed multi-category rows remain (original §8f pins).
  const multi = deals.filter(({ deal }) => deal.food_categories.length > 1);
  assert.ok(multi.length >= 2, multi.map((m) => `${m.venue.id}:${m.deal.items[0].text}`).join("; "));

  const claddagh = venues.find((v) => v.id === "claddagh-pub");
  const sat = claddagh.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.deepEqual(sat.food_categories, ["wings", "sandwich/cheesesteak"]);

  const wedFood = claddagh.deals.find(
    (d) => d.days[0] === "wed" && d.items.some((i) => /Burger/i.test(i.text)),
  );
  assert.deepEqual(wedFood.food_categories, ["burger", "sandwich/cheesesteak"]);

  // Trap rows that must stay single-element (steak-inside-cheesesteak / filling).
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  assert.deepEqual(byId["hucks-american-craft"].deals.find((d) => d.days[0] === "sun" && d.items[0].text.includes("Cheesesteak")).food_categories, ["sandwich/cheesesteak"]);
  assert.deepEqual(byId.smaltimore.deals.find((d) => d.days.includes("tue") && d.items.some((i) => /Taco/i.test(i.text))).food_categories, ["tacos"]);
  assert.deepEqual(byId["mahaffeys-pub"].deals.find((d) => d.days[0] === "fri").food_categories, ["sandwich/cheesesteak"]);
  assert.deepEqual(byId["good-vibes-cantina"].deals.find((d) => d.days[0] === "thu" && d.status !== "held").food_categories, ["fajitas"]);
  assert.deepEqual(byId.smaltimore.deals.find((d) => d.days[0] === "wed").food_categories, ["sushi"]);

  // Real board shows both Claddagh Sat chips.
  const satHtml = await boardFor(new Date("2026-08-08T16:00:00Z")); // Sat Aug 8 2026 EDT noon-ish
  const claddaghCards = cardsFor(satHtml, "Claddagh Pub");
  const satCard = claddaghCards.find((c) => c.includes("30 Wings") && c.includes("Cheesesteaks"));
  assert.ok(satCard, "expected Claddagh Saturday card with wings + cheesesteaks");
  assert.match(satCard, /class="chip">Wings<\/span>/);
  assert.match(satCard, /class="chip">Sandwich<\/span>/);
});

// --- Federal Hill pass 1 (item 10) ----------------------------------------

test("Federal Hill view includes South Baltimore for Delia Foley's", async () => {
  const views = await loadViews();
  const fed = views.find((v) => v.slug === "federal-hill");
  assert.ok(fed, "federal-hill view missing");
  assert.deepEqual(fed.neighborhoods, ["Federal Hill", "South Baltimore"]);
  assert.equal(fed.label, "Federal Hill");

  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  for (const id of [
    "nobles-bar-and-grill",
    "livs-tavern",
    "magerks-federal-hill",
    "cross-street-public-house",
  ]) {
    assert.equal(byId[id].neighborhood, "Federal Hill", id);
    assert.equal(byId[id].status, "verified", id);
  }
  // Honest NSA label — marketing says Federal Hill; polygon says South Baltimore.
  assert.equal(byId["delia-foleys"].neighborhood, "South Baltimore");
  assert.equal(byId["delia-foleys"].status, "verified");
  assert.match(byId["delia-foleys"].source_url, /deliafoleysmd\.com/);
  assert.doesNotMatch(byId["delia-foleys"].source_url, /deliafoleys\.pub/);

  const inView = venuesInView(venues, fed);
  assert.ok(inView.some((v) => v.id === "delia-foleys"));
  assert.ok(inView.some((v) => v.id === "nobles-bar-and-grill"));
  // Original five priced Fed Hill venues remain; expansion added quiet stubs on this view.
  assert.ok(inView.length >= 5, `fed-hill view too small: ${inView.length}`);
  for (const id of [
    "nobles-bar-and-grill",
    "livs-tavern",
    "magerks-federal-hill",
    "cross-street-public-house",
    "delia-foleys",
  ]) {
    assert.ok(inView.some((v) => v.id === id), id);
  }
});

test("Union Hill ops_notes record that Mon–Fri is our reading of Weekdays", async () => {
  const uh = (await loadVenues()).find((v) => v.id === "union-hill-kitchen");
  assert.match(uh.ops_notes ?? "", /ordinary reading/i);
  assert.match(uh.ops_notes ?? "", /Weekdays/);
  assert.match(uh.ops_notes ?? "", /does not name specific days/i);
});

test("Fed Hill happy hours ship priced rows without inventing start times where unknown", async () => {
  const venues = await loadVenues();
  const nobles = venues.find((v) => v.id === "nobles-bar-and-grill");
  const hh = nobles.deals.find((d) => d.happy_hour === true);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.ok(hh.items.some((i) => /Domestics/i.test(i.text)));
  // All-day Boh/cans are not happy_hour (UID collision guard with Tue–Fri HH).
  const allday = nobles.deals.find((d) => d.time_window === "all day");
  assert.notEqual(allday.happy_hour, true);

  // Liv's: split Mon–Fri (food+drinks) vs Sat–Sun (drinks only) — venue asterisk.
  const livs = venues.find((v) => v.id === "livs-tavern");
  const livsWeekday = livs.deals.find(
    (d) => d.happy_hour === true && d.days.includes("mon") && !d.days.includes("sat"),
  );
  const livsWeekend = livs.deals.find(
    (d) => d.happy_hour === true && d.days.includes("sat") && d.days.includes("sun"),
  );
  assert.equal(livsWeekday.start, 900);
  assert.equal(livsWeekday.end, 1080);
  assert.match(livsWeekday.time_window, /game days/i);
  assert.ok(livsWeekday.items.some((i) => /HH Food/i.test(i.text)));
  assert.ok(livsWeekday.items.some((i) => /Cocktails/i.test(i.text)));
  assert.equal(livsWeekend.start, 900);
  assert.equal(livsWeekend.end, 1080);
  assert.match(livsWeekend.time_window, /drinks only/i);
  assert.ok(!livsWeekend.items.some((i) => /Food|Cocktails/i.test(i.text)));
  assert.ok(livsWeekend.items.every((i) => /^\$\d/.test(i.text)));

  const delia = venues.find((v) => v.id === "delia-foleys");
  const monThu = delia.deals.find((d) => d.days.includes("mon") && d.happy_hour);
  const fri = delia.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.equal(monThu.end, 1140);
  assert.equal(fri.end, 1080);
});

test("MaGerk's records Weekdays→Mon–Fri inference and cites 32 OZ on image+PDF", async () => {
  const m = (await loadVenues()).find((v) => v.id === "magerks-federal-hill");
  assert.match(m.ops_notes ?? "", /ordinary reading/i);
  assert.match(m.ops_notes ?? "", /Weekdays/);
  assert.match(m.ops_notes ?? "", /32 OZ/i);
  assert.match(m.ops_notes ?? "", /Weekly Specials PDF/i);
  const hh = m.deals.find((d) => d.happy_hour === true);
  assert.equal(hh.items[0].text, "$7 32 OZ Drafts");
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
});

// --- Fells Point pass 1 ---------------------------------------------------

test("Fells Point view: five verified priced + quiet stubs", async () => {
  const views = await loadViews();
  const fells = views.find((v) => v.slug === "fells-point");
  assert.ok(fells, "fells-point view missing");
  assert.deepEqual(fells.neighborhoods, ["Fells Point"]);

  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  assert.equal(byId["alexanders-tavern-fells"].status, "verified");
  assert.equal(byId["thames-street-oyster-house"].status, "verified");
  // CoS hold: flyer-only prices / no $ in page text → not priced cards.
  assert.equal(byId["the-point-in-fells"].status, "open_unverifiable");
  assert.equal(byId["the-point-in-fells"].deals.length, 0);
  assert.match(byId["the-point-in-fells"].notes_public ?? "", /flyer|image/i);
  assert.match(byId["the-point-in-fells"].source_url, /thepointfells\.com/);
  assert.doesNotMatch(byId["the-point-in-fells"].source_url, /thepointinfells/);

  // 2026-08-07 deal-first ship: Horse + Rockwell (Tue only) + Papi's Fells.
  assert.equal(byId["the-horse-you-came-in-on"].status, "verified");
  assert.equal(byId["the-rockwell-fells"].status, "verified");
  assert.equal(byId["papis-taco-joint-fells"].status, "verified");
  assert.equal(byId["the-rockwell-fells"].deals.length, 1);
  assert.deepEqual(byId["the-rockwell-fells"].deals[0].days, ["tue"]);
  assert.match(byId["papis-taco-joint-fells"].source_url, /fellspoint/);
  assert.doesNotMatch(byId["papis-taco-joint-fells"].source_url, /hampden/);

  for (const id of [
    "alexanders-tavern-fells",
    "the-point-in-fells",
    "thames-street-oyster-house",
    "the-horse-you-came-in-on",
    "the-rockwell-fells",
    "papis-taco-joint-fells",
  ]) {
    assert.equal(byId[id].neighborhood, "Fells Point", id);
  }
  // CCE seed trio + Rye stay open_unverifiable — no invented HH $.
  for (const id of ["maxs-taphouse", "admirals-cup", "stuggys", "rye-of-baltimore"]) {
    assert.ok(byId[id], `${id} quiet stub missing`);
    assert.equal(byId[id].status, "open_unverifiable", id);
    assert.equal(byId[id].deals.length, 0, id);
  }

  const inView = venuesInView(venues, fells);
  assert.equal(inView.length, 10);
  assert.deepEqual(
    inView.map((v) => v.id).sort(),
    [
      "admirals-cup",
      "alexanders-tavern-fells",
      "maxs-taphouse",
      "papis-taco-joint-fells",
      "rye-of-baltimore",
      "stuggys",
      "thames-street-oyster-house",
      "the-horse-you-came-in-on",
      "the-point-in-fells",
      "the-rockwell-fells",
    ].sort(),
  );
});

test("2026-08-07 deal-first load: Horse, Rockwell, Papi's Fells + Hampden", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const hampden = views.find((v) => v.slug === "hampden");
  assert.ok(hampden, "hampden view missing");
  assert.deepEqual(hampden.neighborhoods, ["Hampden"]);

  const horse = byId["the-horse-you-came-in-on"];
  assert.ok(horse);
  assert.match(horse.source_url, /thehorsebaltimore\.com\/specials/);
  const horseHH = horse.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(horseHH.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(horseHH.start, 960);
  assert.equal(horseHH.end, 1200);
  assert.ok(horseHH.items.some((i) => /\$3 Domestic/.test(i.text)));
  // Worker-contingent industry night must not ship.
  for (const d of horse.deals) {
    assert.doesNotMatch(d.items.map((i) => i.text).join(" "), /25%|Industry|Hospitality/i);
  }

  const rock = byId["the-rockwell-fells"];
  assert.equal(rock.deals.length, 1);
  assert.deepEqual(rock.deals[0].days, ["tue"]);
  assert.ok(rock.deals[0].items.some((i) => /\$4 Beer/.test(i.text)));
  // No priceless every-night / Sunday all-night rows.
  assert.ok(!rock.deals.some((d) => /every night|all night/i.test(d.time_window ?? "")));

  const papisF = byId["papis-taco-joint-fells"];
  assert.match(papisF.source_url, /papistacojoint\.com\/fellspoint/);
  const fHH = papisF.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(fHH.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(fHH.start, 900);
  assert.equal(fHH.end, 1080);
  assert.ok(fHH.items.some((i) => /\$10 Happy Hour Wings/.test(i.text)));

  const papisH = byId["papis-taco-joint-hampden"];
  assert.equal(papisH.neighborhood, "Hampden");
  assert.match(papisH.source_url, /papistacojoint\.com\/hampden/);
  assert.doesNotMatch(papisH.source_url, /fellspoint/);
  const hHH = papisH.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(hHH.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hHH.start, 900);
  assert.equal(hHH.end, 1080);
  // Distinct sister rows.
  assert.notEqual(papisF.address, papisH.address);
  assert.notEqual(papisF.phone, papisH.phone);

  assert.ok(venuesInView(venues, hampden).some((v) => v.id === "papis-taco-joint-hampden"));
  assert.ok(venuesInView(venues, city).some((v) => v.id === "papis-taco-joint-hampden"));
});

test("Fells Point honesty pins: Fri all-day split, The Point held, oysters deep-link", async () => {
  const venues = await loadVenues();
  const alex = venues.find((v) => v.id === "alexanders-tavern-fells");
  const weekdayHh = alex.deals.find(
    (d) => d.happy_hour && d.days.includes("tue") && !d.days.includes("fri"),
  );
  const friHh = alex.deals.find((d) => d.happy_hour && d.days.length === 1 && d.days[0] === "fri");
  assert.equal(weekdayHh.start, 900);
  assert.equal(weekdayHh.end, 1080);
  assert.equal(friHh.start, null);
  assert.equal(friHh.end, 1080);
  assert.match(friHh.time_window, /all day until 6pm/i);

  const point = venues.find((v) => v.id === "the-point-in-fells");
  assert.equal(point.deals.length, 0);
  assert.match(point.ops_notes ?? "", /CoS 2026-08-06 hold/i);

  const thames = venues.find((v) => v.id === "thames-street-oyster-house");
  assert.equal(
    thames.source_url,
    "https://www.thamesstreetoysterhouse.com/happy-hour.htm",
  );
  for (const d of thames.deals.filter((x) => x.happy_hour)) {
    assert.equal(d.source_url, "https://www.thamesstreetoysterhouse.com/happy-hour.htm");
    assert.ok(d.items.some((i) => /\$2/.test(i.text) && /oyster/i.test(i.text)));
    assert.ok(d.items.some((i) => /prices not published/i.test(i.text)));
    assert.ok(!d.items.some((i) => /\$\d/.test(i.text) && /cocktail|beer|wine/i.test(i.text)));
  }
});
