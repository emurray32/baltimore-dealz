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
import { escapeHtml, formatPhone, renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";
import { renderVenuePage } from "../src/venue.js";
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
    .filter((day) => day.rows.some((row) => row.deals.some((d) => d.items.some((i) => i.text === "Brunch"))))
    .map((day) => day.key);

  assert.deepEqual(brunchDays, ["sat", "sun"]);
});

test("every day of the week has at least one seeded deal", async () => {
  const venues = venuesInView(await loadVenues(), CANTON);
  for (const day of weekByDay(venues)) {
    assert.ok(day.rows.length > 0, `no deals seeded for ${day.key}`);
  }
});

test("exactly one tile per venue, even when a venue has multiple same-day deals", async () => {
  // Monday: Huck's has 2 deals, Claddagh has 2 deals, Smaltimore has 2 deals.
  // Scope to the "On tonight" cards, not the full board with accordion.
  const html = await boardFor(new Date("2026-08-03T20:00:00Z"));
  const tonight = html.split('<section id="tonight-board"')[1].split("</section>")[0];

  const tileCount = (name) => {
    const escaped = escapeHtml(name);
    let count = 0;
    const blocks = tonight.split("<article class=\"card\"");
    for (const block of blocks) {
      if (block.includes(`>${escaped}<`) || block.includes(`>${escaped} `)) {
        count++;
      }
    }
    return count;
  };

  assert.equal(tileCount("Huck's American Craft"), 1, "Huck's must be exactly one tile");
  assert.equal(tileCount("Claddagh Pub"), 1, "Claddagh must be exactly one tile");
  assert.equal(tileCount("Smaltimore"), 1, "Smaltimore must be exactly one tile");
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
      "barracudas-locust-point",
      "bo-brooks",
      "cross-street-market",
      "crossbar",
      "gameon-bar-arcade",
      "honeypot",
      "kislings-tavern",
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
    // El Bufalo left this list on 2026-08-11: its Instagram states the days.
    "good-vibes-cantina:$7 Margaritas", // bio 3-7pm vs posts 4-8pm
    "mahaffeys-pub:Sliders",
    "mamas-on-the-half-shell:Happy Hour ALL DAY", // website vs Instagram Monday
    "pig-and-rooster-smokehouse:$5 Burger of the Day (rotating)", // source line has $5 AND $7
    "smaltimore:All Night Happy Hour",
    "smaltimore:Bottomless Brunch",
    "the-dive:Happy Hour"
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
  // No seed venue is held-only any more (El Bufalo shipped 2026-08-11, then
  // Stackhouse). The rule still has to hold, so build the case rather than
  // delete the guard or pin it to whichever venue happens to be parked today.
  const heldOnly = venue({
    id: "held-only-fixture",
    name: "Held Only Fixture",
    deals: [
      {
        days: ["sat"],
        items: [{ text: "Zqx Held Fixture Pint", price: "$4" }],
        start: 900,
        end: 1080,
        time_window: "3pm-6pm",
        status: "held",
        food_categories: ["drink"],
      },
    ],
  });

  assert.deepEqual(venueShapeErrors(heldOnly), []); // still valid data
  assert.ok(heldOnly.deals.every((d) => !isDealRenderable(d)));
  assert.equal(hasShowableDeal(heldOnly), false);

  // And the real seed still honours it: nothing held reaches a board.
  const all = await loadVenues();
  const html = await boardFor(new Date("2026-08-08T20:00:00Z")); // a Saturday
  for (const v of all) {
    for (const d of v.deals.filter((x) => !isDealRenderable(x))) {
      for (const item of d.items) {
        // Skip texts that also live on a showable row — a shared line on the
        // board is not evidence of a held leak.
        const shared = all.some((o) =>
          o.deals.some((od) => isDealRenderable(od) && od.items.some((i) => i.text === item.text)),
        );
        if (shared) continue;
        assert.ok(!html.includes(escapeHtml(item.text)), `${v.id}: held "${item.text}" rendered`);
      }
    }
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
  // Tuscany-Canterbury / Little Italy / Upper Fells Point / Waltherson / Belair-Edison / Charles Village / Morrell Park / Bolton Hill / Jones Falls Area / Old Goucher / Otterbein / Johns Hopkins Homewood / Greenmount West / Highlandtown / Westfield / Downtown West / Mount Washington / Remington / Greektown have no home page; those venues are citywide-only.
  const citywideOnly = new Set(["Tuscany-Canterbury", "Little Italy", "Upper Fells Point", "Waltherson", "Belair-Edison", "Charles Village", "Morrell Park", "Bolton Hill", "Jones Falls Area", "Old Goucher", "Otterbein", "Johns Hopkins Homewood", "Greenmount West", "Highlandtown", "Westfield", "Downtown West", "Mount Washington", "Remington", "Greektown"]);
  const covered = new Set(
    (await loadViews())
      .filter((view) => Array.isArray(view.neighborhoods))
      .flatMap((view) => view.neighborhoods),
  );
  for (const v of await loadVenues()) {
    if (citywideOnly.has(v.neighborhood)) continue;
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
    ["bark-social-canton", "hucks-american-craft", "mobtown-brewing"].sort(),
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


test("dealTiming: finished vs on now vs starts later vs hours_unlisted; end:null never finished", () => {
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

  // Untimed / all-day — no start → hours_unlisted, never invent a window.
  assert.equal(dealTiming({ start: null, end: null }, 12 * 60), "hours_unlisted");
  assert.equal(dealTiming({ start: undefined, end: undefined }, 3 * 60), "hours_unlisted");
});

// --- B1: untimed deals stop claiming "On now" -----------------------------

test("B1: untimed row at 9am is hours_unlisted, not on_now", () => {
  // 65 of 146 deals have no start — at 9am they'd false-claim "On now".
  assert.equal(dealTiming({ start: null, end: null }, 9 * 60), "hours_unlisted");
  assert.notEqual(dealTiming({ start: null, end: null }, 9 * 60), "on_now");
});

test("B1: 'until 7pm' row (start null, end set) at 9am → unlisted; at 19:30 → finished", () => {
  // A venue that publishes an end time but no start, e.g. "Specials until 7pm".
  const until7 = { start: null, end: 19 * 60 }; // end 7pm
  assert.equal(dealTiming(until7, 9 * 60), "hours_unlisted");
  // At 7:30pm the end has passed → finished via the existing hasEnded path.
  assert.equal(dealTiming(until7, 19 * 60 + 30), "finished");
  // Before end but no start → still hours_unlisted (not on_now).
  assert.equal(dealTiming(until7, 14 * 60), "hours_unlisted");
});

test("B1: fully-timed row buckets exactly as before", () => {
  const timed = { start: 15 * 60, end: 18 * 60 };
  assert.equal(dealTiming(timed, 14 * 60), "starts_later");
  assert.equal(dealTiming(timed, 17 * 60), "on_now");
  assert.equal(dealTiming(timed, 18 * 60 + 30), "finished");
});

// Mutation test: verify the suite catches a revert to the old rule.
test("B1 mutation: if untimed were on_now again, this test would fail (prove we'd catch the revert)", () => {
  // This is the CORRECT behaviour — untimed is NOT on_now.
  assert.notEqual(dealTiming({ start: null, end: null }, 9 * 60), "on_now");

  // If someone reverts dealTiming to return "on_now" for null start, the line
  // above would flip from notEqual to equal and still pass — so we also assert
  // the actual value. A revert changes this to "on_now" and the suite goes red.
  assert.equal(dealTiming({ start: null, end: null }, 9 * 60), "hours_unlisted");
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
        const max = field === "end" ? 1440 : 1439;
        assert.ok(
          value === null || (Number.isInteger(value) && value >= 0 && value <= max),
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
  assert.ok(stackhouse.deals.some((d) => d.prices_published === false));

  // (3) held — a different fact again, and it never renders
  const held = venues.flatMap((v) => v.deals).filter((d) => !isDealRenderable(d));
  assert.ok(held.length > 0);
});

test("prices_published:false renders an honest flag, not a blank", async () => {
  // Until 2026-08-11 Stackhouse was held, so the only honest signal was its
  // notes_public sentence. Now the row renders, and the flag rides the card
  // itself — which is where someone actually reads it. notes_public is not
  // printed once a venue has a showable deal.
  const venues = await loadVenues();
  const stackhouse = venues.find((v) => v.id === "hudson-street-stackhouse");
  const views = await loadViews();
  const html = renderVenuePage(stackhouse, views, new Date("2026-08-03T20:00:00Z"));
  assert.match(html, /Prices not published by the venue/i);
  assert.match(html, /3pm-7pm/i, "the published window still shows");
  assert.doesNotMatch(html, /\$\d/, "a times-only venue must show no price");
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

  // City-wide board — notes_public venues live outside Canton (Fells, Harbor East, Fed Hill).
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore") ?? defaultView(views);
  const monday = await boardFor(new Date("2026-08-03T20:00:00Z"), city);
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
  // Still image-only: the $5.99 was read off the homepage graphic, not page text.
  // The flag records where the price came from, not whether we have one.
  assert.equal(lees.deal_format, "image");
  assert.equal(lees.deals.length, 1);
  assert.equal(lees.deals[0].recurrence, "first");
  assert.deepEqual(lees.deals[0].days, ["wed"]);

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
  const weekdayHh = mama.deals.find((d) => d.items.some((i) => i.text === "Happy Hour"));
  assert.ok(!weekdayHh, "the unpriced Mon–Fri Happy Hour row should be removed");

  // The Instagram "ALL DAY Mondays" copy stays held and still cites Instagram.
  const monAllDay = mama.deals.find((d) =>
    d.items.some((i) => i.text === "Happy Hour ALL DAY"),
  );
  assert.equal(monAllDay?.status, "held");
  assert.equal(monAllDay?.source_url, "https://www.instagram.com/mamasonthehalfshell/");

  const venues = venuesForView(await loadVenues(), CANTON);
  const html = renderBoard(venues, CANTON, [CANTON], new Date("2026-08-05T20:00:00Z"));
  const mamasHtml = cardsFor(html, "Mama's on the Half Shell").join("");
  assert.match(mamasHtml, /\$6 Classic Crushes/);
  assert.doesNotMatch(mamasHtml, /Happy Hour: 3pm/);
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

test("Stackhouse keeps only held times-only happy-hour data — no 2019 food prices", async () => {
  const stack = (await loadVenues()).find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stack.deals.some((d) => d.prices_published === false));
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

test("an unpriced row may render only as a real happy hour with a published window", async () => {
  // 2026-08-10 rule: unpriced rows came OFF the board — a bare name is not a deal.
  // 2026-08-11, Eric: "Happy hour 3-6pm works—that's OK". So the rule narrows
  // rather than disappears. An unpriced row is allowed ONLY when it is a happy
  // hour AND the venue published the window; everything else stays held.
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  const unpricedShowing = venues.flatMap((v) =>
    v.deals
      .filter((d) => d.prices_published === false && isDealRenderable(d))
      .map((d) => ({ id: v.id, deal: d })),
  );

  assert.deepEqual(
    [...new Set(unpricedShowing.map((r) => r.id))].sort(),
    ["blackwall-hitch", "captain-james-landing", "hershs", "holy-frijoles", "hudson-street-stackhouse", "the-outpost", "the-point-in-fells"],
    "only the times-only happy-hour venues may show an unpriced row",
  );

  for (const { id, deal } of unpricedShowing) {
    assert.equal(deal.happy_hour, true, `${id}: an unpriced row must be a happy hour`);
    assert.ok(deal.time_window, `${id}: an unpriced row must carry a published window`);
    assert.ok(deal.verified_date, `${id}: an unpriced row must be dated`);
  }

  // The venues whose rows were pulled in the 2026-08-10 cleanup stay pulled:
  // each is held for its own unresolved reason, not for want of a price.
  const stillHeld = [
    ...byId["mamas-on-the-half-shell"].deals,
    ...byId["the-dive"].deals,
    ...byId.smaltimore.deals,
    ...byId["mahaffeys-pub"].deals,
  ].filter((d) => d.prices_published === false && isDealRenderable(d));
  assert.equal(stillHeld.length, 0);

  const thames = byId["thames-street-oyster-house"];
  for (const deal of thames.deals) {
    assert.ok(!deal.items.some((item) => /prices not published/i.test(item.text)));
  }

  const mamasWednesday = byId["mamas-on-the-half-shell"].deals.find(
    (d) => d.days.length === 1 && d.days[0] === "wed",
  );
  assert.ok(mamasWednesday);
  assert.deepEqual(mamasWednesday.items, [
    { text: "1/2 Off Mussels", price: "1/2 off" },
    { text: "$6 Classic Crushes", price: "$6" },
  ]);
});

// --- zero-deal venues off the board (Eric rule 2026-08-07) ----------------

test("zero-deal and held-only venues stay in data but off the board and map section", async () => {
  const venues = venuesInView(await loadVenues(), CANTON);
  const quiet = noDealVenues(venues);
  const ids = quiet.map((v) => v.id).sort();

  // Still in venues.json (helper still finds them) — render change, not delete.
  assert.deepEqual(ids, [
    "baltimore-tap-house",
    "bo-brooks",
    "honeypot",
    "kislings-tavern",
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

  // Held offer text must never appear. "$7 Sangria" is a HELD-ONLY line (Good
  // Vibes' window is still disputed); "$7 Margaritas" would be a false marker
  // because it also sits in one of their renderable rows.
  assert.doesNotMatch(html, /\$7 Sangria/);
  // Lee's reason (and inventable promo text) must not appear on the board.
  assert.doesNotMatch(html, /monthly promo as an image we cannot read/i);
  assert.doesNotMatch(html, /Build-your-own-burger/i);
  assert.doesNotMatch(html, /first Wednesday/i);

  // Board still has showable Canton/Brewers Hill deal venues.
  assert.match(html, /Huck|Claddagh|Mama|Mahaffey|article class="card"/);
});

test("Lee's notes_public is a reason, not an offer", async () => {
  const lees = (await loadVenues()).find((v) => v.id === "lees-pint-and-shell");
  // The rule is unchanged: notes_public describes the venue, it never restates
  // the offer. The offer lives in the deal row, where the source URL and proof
  // quote travel with it.
  assert.match(lees.notes_public, /monthly special/i);
  assert.doesNotMatch(lees.notes_public, /Build-your-own-burger|first Wednesday|5\.99|Cheeseburger/i);
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

  // El Bufalo shipped 2026-08-11 — it now carries a real verified_date, which
  // is the point: a hold clears only when the disputed fact is settled.
  const elBufalo = byId["el-bufalo"].deals.find((d) => d.happy_hour === true);
  assert.equal(elBufalo.status, undefined, "El Bufalo must no longer be held");
  assert.equal(elBufalo.verified_date, "2026-08-11");

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
  assert.ok(stack.deals.some((d) => d.prices_published === false));
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
  assert.deepEqual(bySlug["locust-point"].neighborhoods, [
    "Locust Point",
    "Riverside",
    "Port Covington",
    "Baltimore Peninsula",
  ]);

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

  // Wayward / M8 never invented onto the board. Azumi ships 2026-08-07 from venue PDF.
  for (const id of ["wayward", "m8-beer"]) {
    assert.equal(byId[id], undefined, id);
  }
  assert.equal(byId.azumi?.status, "verified");

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
    // blackwall-hitch left this list 2026-08-11 — it now shows a times-only
    // happy hour. It still invents no prices, which is what this guards.
    // bark-social-canton left this list 2026-08-19 — official Baltimore HH
    // page now publishes priced weekday specials.
    "barracudas-locust-point",
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

  // Every seed row that names what is on offer carries the field. A times-only
  // happy hour (Eric 2026-08-11) publishes no items, so there is nothing to
  // categorise — tagging it "drink" would be a guess, and it correctly means
  // those venues do not surface under a food filter.
  for (const { venue, deal } of deals) {
    // A times-only happy hour (Eric 2026-08-11) publishes no items, so there
    // may be nothing to categorise. Some carry a category from earlier
    // research; neither is required, so this rule simply does not apply.
    if (deal.prices_published === false && isDealRenderable(deal)) continue;
    // Whole-menu % off / prix-fixe spanning the menu is not one vocab tag
    // (Don Tigre census remainder; Gertrude's leftover loadable; Indigma thaali;
    // Raffy's Thursday date night).
    if (
      (venue.id === "don-tigre" &&
        deal.items.some((i) => i.text === "18% off on the whole menu")) ||
      (venue.id === "gertrudes" &&
        deal.items.some((i) => i.text === "$20 Dinners" || i.text === "$36 3-Course Dinner")) ||
      (venue.id === "indigma" &&
        deal.items.some((i) => i.text === "Thaali $16.95")) ||
      (venue.id === "raffys-on-36th" &&
        deal.items.some((i) => i.text === "Share a meal, a drink, and conversation for $45 for the two of you"))
    ) {
      assert.equal(deal.food_categories, undefined);
      continue;
    }
    assert.ok(
      Array.isArray(deal.food_categories) && deal.food_categories.length > 0,
      `${venue.id}: missing food_categories on ${deal.items[0].text}`,
    );
  }

  // Claddagh Sat + Wed multi-category rows remain (original §8f pins).
  const multi = deals.filter(({ deal }) => (deal.food_categories?.length ?? 0) > 1);
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

test("Fells Point view: eight verified priced + quiet stubs", async () => {
  const views = await loadViews();
  const fells = views.find((v) => v.slug === "fells-point");
  assert.ok(fells, "fells-point view missing");
  assert.deepEqual(fells.neighborhoods, ["Fells Point"]);

  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));

  assert.equal(byId["alexanders-tavern-fells"].status, "verified");
  assert.equal(byId["thames-street-oyster-house"].status, "verified");
  // 2026-08-11: shipped as a times-only happy hour (Eric). Prices still live
  // only in flyer images, so it carries a window and no dollar amounts.
  assert.equal(byId["the-point-in-fells"].status, "verified");
  assert.equal(byId["the-point-in-fells"].deals.length, 2);
  assert.ok(byId["the-point-in-fells"].deals.every((d) => d.prices_published === false));
  assert.match(byId["the-point-in-fells"].notes_public ?? "", /flyer|image/i);
  assert.match(byId["the-point-in-fells"].source_url, /thepointfells\.com/);
  assert.doesNotMatch(byId["the-point-in-fells"].source_url, /thepointinfells/);

  // 2026-08-07 deal-first ship: Horse + Rockwell (Tue only) + Papi's Fells + Tandoor + Todd + Choptank.
  assert.equal(byId["the-horse-you-came-in-on"].status, "verified");
  assert.equal(byId["the-rockwell-fells"].status, "verified");
  assert.equal(byId["papis-taco-joint-fells"].status, "verified");
  assert.equal(byId["harbor-tandoor"].status, "verified");
  assert.equal(byId["todd-conners"].status, "verified");
  assert.equal(byId["the-choptank"].status, "verified");
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
    "harbor-tandoor",
    "todd-conners",
    "the-choptank",
    "waterfront-hotel",
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
  assert.equal(inView.length, 18);
  assert.deepEqual(
    inView.map((v) => v.id).sort(),
    [
      "admirals-cup",
      "alexanders-tavern-fells",
      "bunnys-buckets",
      "harbor-tandoor",
      "la-calle",
      "maxs-taphouse",
      "papis-taco-joint-fells",
      "pitango-bakery",
      "rec-pier-chop-house",
      "rye-of-baltimore",
      "stuggys",
      "thames-street-oyster-house",
      "the-choptank",
      "the-horse-you-came-in-on",
      "the-point-in-fells",
      "the-rockwell-fells",
      "todd-conners",
      "waterfront-hotel",
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
  // Public copy only — no-clock evidence lives in ops_notes, not time_window.
  assert.equal(rock.deals[0].time_window, "karaoke night");
  assert.doesNotMatch(rock.deals[0].time_window ?? "", /no clock/i);
  assert.match(rock.ops_notes ?? "", /no clock/i);
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

test("2026-08-07 CoS-cleared seven: Tandoor Todd Choptank Joyce Azumi Watershed Ace", async () => {
  const venues = await loadVenues();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const views = await loadViews();
  const city = views.find((v) => v.slug === "baltimore");
  const fells = views.find((v) => v.slug === "fells-point");
  const harbor = views.find((v) => v.slug === "inner-harbor");
  const fed = views.find((v) => v.slug === "federal-hill");

  // Fells HTML + PDF
  const tandoor = byId["harbor-tandoor"];
  assert.equal(tandoor.status, "verified");
  assert.match(tandoor.source_url, /harbortandoor\.com\/lunch-happy-hour/);
  const tHH = tandoor.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(tHH.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(tHH.start, 900);
  assert.equal(tHH.end, 1080);
  assert.ok(tHH.items.some((i) => /\$8 Papadum/.test(i.text)));
  assert.ok(tHH.items.some((i) => /\$4 Local Draft/.test(i.text)));

  const todd = byId["todd-conners"];
  assert.equal(todd.status, "verified");
  assert.equal(todd.deals.length, 5);
  assert.ok(todd.deals.some((d) => d.days[0] === "mon" && /\$7 Build Your Own Burger/.test(d.items[0].text)));
  assert.ok(todd.deals.some((d) => d.days.includes("sat") && d.items.some((i) => /\$4 Mimosas/.test(i.text))));
  // Game-day contingent specials must not ship.
  for (const d of todd.deals) {
    assert.doesNotMatch(d.items.map((i) => i.text).join(" "), /Oriole|Natty Boh|Devil.?s Backbone|game.?day/i);
  }

  const chop = byId["the-choptank"];
  assert.equal(chop.status, "verified");
  assert.match(chop.notes_public ?? "", /bar only/i);
  assert.match(chop.ops_notes ?? "", /source_document_date=2025-06-09/);
  assert.doesNotMatch(chop.source_url, /thechoptank\.com(?!restaurant)/);
  const cHH = chop.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(cHH.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(cHH.start, 960);
  assert.equal(cHH.end, 1140);
  assert.ok(cHH.items.some((i) => /\$8 Crushes/.test(i.text)));
  assert.ok(cHH.items.some((i) => /\$1\.50/.test(i.text) && /Oyster/i.test(i.text)));

  // Harbor East PDFs
  const joyce = byId["james-joyce-irish-pub"];
  assert.equal(joyce.neighborhood, "Harbor East");
  assert.match(joyce.notes_public ?? "", /bar only/i);
  assert.match(joyce.ops_notes ?? "", /source_document_date=2026-04-27/);
  const jHH = joyce.deals.find((d) => d.happy_hour === true);
  assert.equal(jHH.start, 960);
  assert.equal(jHH.end, 1140);
  assert.ok(jHH.items.some((i) => /\$8 Irish Orange Crush/.test(i.text)));

  const azumi = byId["azumi"];
  assert.equal(azumi.neighborhood, "Harbor East");
  assert.match(azumi.notes_public ?? "", /inside bar/i);
  assert.match(azumi.ops_notes ?? "", /source_document_date=2026-05-05/);
  const aHH = azumi.deals.find((d) => d.happy_hour === true);
  assert.equal(aHH.start, 900);
  assert.equal(aHH.end, 1080);
  assert.ok(aHH.items.some((i) => /\$10 Cocktails/.test(i.text)));
  assert.ok(aHH.items.some((i) => /\$7 Handrolls/.test(i.text)));

  const ace = byId["order-of-the-ace"];
  assert.equal(ace.neighborhood, "Harbor East");
  assert.equal(ace.phone, undefined);
  assert.match(ace.ops_notes ?? "", /source_document_date=2025-09-12/);
  assert.match(ace.ops_notes ?? "", /filename/i);
  const oHH = ace.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(oHH.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(oHH.start, 1020);
  assert.equal(oHH.end, 1140);
  // Both salads ship at $7 — do not drop one.
  assert.ok(oHH.items.some((i) => /Chopped Salad \$7/.test(i.text)));
  assert.ok(oHH.items.some((i) => /Caesar Salad \$7/.test(i.text)));
  // No Monday invented from PDF "weekdays".
  assert.ok(!oHH.days.includes("mon"));

  // Watershed: upgrade from quiet stub + dual window
  const shed = byId["watershed"];
  assert.equal(shed.status, "verified");
  assert.equal(shed.neighborhood, "Federal Hill");
  assert.equal(shed.phone, "(410) 888-3878");
  assert.match(shed.notes_public ?? "", /March 2025|Cross Street/i);
  assert.match(shed.ops_notes ?? "", /source_document_date=2025-03-20/);
  assert.match(shed.ops_notes ?? "", /early re-check/i);
  assert.equal(shed.deals.length, 2);
  const dayHH = shed.deals.find((d) => d.start === 900);
  const late = shed.deals.find((d) => d.start === 1320);
  assert.deepEqual(dayHH.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(dayHH.end, 1080);
  assert.deepEqual(late.days, ["fri", "sat"]);
  assert.equal(late.end, null);
  assert.match(late.time_window, /10pm-1am/i);
  assert.ok(dayHH.items.some((i) => /\$3 \/ 16oz Beer/.test(i.text)));
  assert.ok(dayHH.items.some((i) => /Buck-a-Shuck|\$1 each/.test(i.text)));

  // Views pick them up
  assert.ok(venuesInView(venues, fells).some((v) => v.id === "the-choptank"));
  assert.ok(venuesInView(venues, harbor).some((v) => v.id === "azumi"));
  assert.ok(venuesInView(venues, harbor).some((v) => v.id === "order-of-the-ace"));
  assert.ok(venuesInView(venues, fed).some((v) => v.id === "watershed"));
  assert.ok(venuesInView(venues, city).some((v) => v.id === "order-of-the-ace"));

  // Board math: 28 showable before this load → 35 after (6 new + Watershed upgrade).
  // AJ's / Nick's / Rusty (batch 39) bumps showable 35 → 38 and total 63 → 66.
  // Mount Vernon batch 1 (Owl / Sugarvale / Unity) → showable 41, total 69.
  // Fifty: +Monarque Alma Wicked Bluebird → showable 50, total 78.
  const showable = venues.filter((v) => (v.deals || []).some((d) => d.status !== "held")).length;
  // 2026-08-10: Lee's Pint & Shell joins on monthly recurrence (first Wednesday),
  // taking showable 49 -> 50. 2026-08-11: El Bufalo unheld (Instagram settled
  // its days), 50 -> 51.
  // 2026-08-18: Waterfront Hotel + The Chasseur + Raw & Refined → 57 -> 60 / 80 -> 83.
  // 2026-08-18: Verde + HappyJack + Pusser's + Tutti Gusti → 60 -> 64 / 83 -> 87.
  // 2026-08-18: Ambassador Dining Room → 64 -> 65 / 87 -> 88.
  // 2026-08-18: Amicci's → 65 -> 66 / 88 -> 89.
  // 2026-08-18: Angie's Seafood → 66 -> 67 / 89 -> 90.
  // 2026-08-18: Animal Boy → 67 -> 68 / 90 -> 91.
  // 2026-08-18: Baltimore Seafood → 68 -> 69 / 91 -> 92.
  // 2026-08-18: The Barn & Lodge at The Rotunda → 69 -> 70 / 92 -> 93.
  // 2026-08-19: Bark Social Canton filled + Hull Street Blues, Rye Street Tavern,
  // Phillips Seafood Inner Harbor, Holy Frijoles → 70 -> 75 / 93 -> 97.
  // 2026-08-19: Captain James Landing → 75 -> 76 / 97 -> 98.
  // 2026-08-19: Bertha's Soul Food → 76 -> 77 / 98 -> 99.
  // 2026-08-19: Blue Pit BBQ → 77 -> 78 / 99 -> 100.
  // 2026-08-20: Bunny's Buckets & Bubbles → 78 -> 79 / 100 -> 101.
  // 2026-08-20: first 5-venue batch (Brewer's Cask · Charles Village Pub ·
  // Chuck's Trading Post · Cinghiale · Clasé Lounge) → 79 -> 84 / 101 -> 106.
  // 2026-08-20: census remainder (CookHouse · Cosima · Cypriana · Don Tigre ·
  // Dutch Courage · Dylan's Oyster Cellar) → 84 -> 90 / 106 -> 112.
  // 2026-08-20: leftover loadable (Facci · Fogo de Chao · The Food Market ·
  // Gertrude's · Guilford Hall Brewery · Hair of the Dog) → 90 -> 96 / 112 -> 118.
  // 2026-08-20: leftover loadable (Hard Rock Cafe · Hersh's · HomeSlyce Mt. Vernon ·
  // HomeSlyce JHU) → 96 -> 100 / 118 -> 122.
  // 2026-08-21: leftover loadable (iBar · Indigma · Johnny Rad's · Kechy Pizza ·
  // B&O American Brasserie) → 100 -> 105 / 122 -> 127.
  // 2026-08-21: leftover loadable (La Calle · La Cuchara) → 105 -> 107 / 127 -> 129.
  // 2026-08-21: leftover loadable (Sally O's · Shotti's · Silver Queen ·
  // Empanada Lady · True Chesapeake) → 107 -> 112 / 129 -> 134.
  // 2026-08-21: leftover loadable (Valentino's · Wet City) → 112 -> 114 / 134 -> 136.
  // 2026-08-21: leftover loadable (Tabor · Marta · Maryland Yards · McCormick & Schmick's) → 114 -> 118 / 136 -> 140.
  // 2026-08-21: leftover loadable (Midlina · Mt. Washington Tavern) → 118 -> 120 / 140 -> 142.
  // 2026-08-21: leftover loadable (Nepenthe Brewing · Octobar) → 120 -> 122 / 142 -> 144.
  // 2026-08-21: leftover loadable (Alexander's Tavern Soha · Rec Pier Chop House) → 122 -> 124 / 144 -> 146.
  // 2026-08-21: leftover loadable (Pink Flamingo) → 124 -> 125 / 146 -> 147.
  // 2026-08-21: leftover loadable (Pitango Bakery) → 125 -> 126 / 147 -> 148.
  // 2026-08-21: leftover loadable (Estiatorio Plaka) → 126 -> 127 / 148 -> 149.
  // 2026-08-21: leftover loadable (Raffy's on 36th) → 127 -> 128 / 149 -> 150.
  assert.equal(showable, 128);
  assert.equal(venues.length, 150);
});


test("2026-08-19 official-site pass: Bark Social fill + thin-hood adds", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bark = byId["bark-social-canton"];
  assert.ok(bark);
  assert.deepEqual(venueShapeErrors(bark), []);
  assert.equal(bark.status, "verified");
  assert.equal(bark.id, "bark-social-canton");
  assert.equal(bark.neighborhood, "Brewers Hill");
  assert.equal(bark.source_url, "https://barksocial.com/pages/baltimore-happy-hour");
  assert.equal(bark.last_verified, "2026-08-19");
  assert.equal(bark.deals.length, 5);
  assert.equal(
    bark.notes_public,
    "Humans are free to enter (except during special ticketed events). Dogs need a membership or a guest pass — club $45/month or $385/year; weekday day pass $12, weekend $15. Register the dog before you arrive. No Saturday or Sunday specials on the happy hour menu.",
  );
  assert.match(bark.ops_notes ?? "", /barksocial\.com\/pages\/membership/);
  assert.match(bark.ops_notes ?? "", /barksocial\.com\/pages\/faq/);
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "bark-social-canton"));

  const hull = byId["hull-street-blues"];
  assert.ok(hull);
  assert.deepEqual(venueShapeErrors(hull), []);
  assert.equal(hull.neighborhood, "Locust Point");
  assert.equal(hull.status, "verified");
  assert.ok(hull.deals.some((d) => d.days.includes("mon") && d.items.some((i) => i.price === "$13")));
  const hullTrivia = hull.deals.find((d) => d.items.some((i) => /Trivia/i.test(i.text)));
  assert.ok(hullTrivia);
  assert.equal(hullTrivia.start, 1170);
  assert.equal(hullTrivia.time_window, "7:30pm");
  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "hull-street-blues"));

  const rye = byId["rye-street-tavern"];
  assert.ok(rye);
  assert.deepEqual(venueShapeErrors(rye), []);
  assert.equal(rye.neighborhood, "Baltimore Peninsula");
  assert.ok(rye.deals[0].happy_hour);
  assert.equal(rye.notes_public, undefined);
  assert.doesNotMatch(rye.notes_public ?? "", /published for the bar/i);
  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "rye-street-tavern"));
  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "nicks-fish-house"));

  const phillips = byId["phillips-seafood-inner-harbor"];
  assert.ok(phillips);
  assert.deepEqual(venueShapeErrors(phillips), []);
  assert.equal(phillips.neighborhood, "Inner Harbor");
  assert.ok(phillips.deals[0].items.some((i) => i.price === "$5"));
  const phText = phillips.deals[0].items.map((i) => i.text).join(" | ");
  assert.match(phText, /Hush puppies \$9/i);
  assert.match(phText, /mussels \$14/i);
  assert.match(phText, /shrimp \$16/i);
  assert.match(phText, /pretzel.*\$19/i);
  assert.match(phText, /quesadilla \$19/i);
  assert.match(phText, /hot dog \$16/i);
  assert.match(phillips.notes_public ?? "", /bar and lounge only/i);
  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "phillips-seafood-inner-harbor"));

  const holy = byId["holy-frijoles"];
  assert.ok(holy);
  assert.deepEqual(venueShapeErrors(holy), []);
  assert.equal(holy.neighborhood, "Hampden");
  assert.equal(holy.deals[0].prices_published, false);
  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "holy-frijoles"));
});

test("Captain James Landing joins 2026-08-19 (Canton weekday plates + crab house HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cj = byId["captain-james-landing"];
  assert.ok(cj, "captain-james-landing missing");
  assert.deepEqual(venueShapeErrors(cj), []);
  assert.equal(cj.name, "Captain James Landing");
  assert.equal(cj.neighborhood, "Canton");
  assert.equal(
    cj.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-19",
  );
  assert.equal(cj.status, "verified");
  assert.equal(cj.address, "2127 Boston St, Baltimore, MD 21231");
  assert.doesNotMatch(cj.address, /Aliceanna|2121/);
  assert.equal(cj.phone, "(410) 327-8600");
  assert.doesNotMatch(cj.phone ?? "", /675-1819/);
  assert.equal(cj.source_url, "https://www.captainjameslanding.com/happenings/");
  assert.equal(cj.source_type, "venue_website");
  assert.equal(cj.last_verified, "2026-08-19");
  assert.equal(cj.lat, 39.2840331);
  assert.equal(cj.lon, -76.5862367);
  assert.equal(cj.deals.length, 5);
  assert.match(
    cj.notes_public ?? "",
    /dine-?in only/i,
    "Crab House HH dine-in restriction must be public",
  );
  assert.match(cj.ops_notes ?? "", /Name=Canton/);
  assert.match(cj.ops_notes ?? "", /2127 Boston/);
  assert.match(cj.ops_notes ?? "", /Do not pin the crab house|2121 Aliceanna/);
  assert.match(cj.ops_notes ?? "", /no clock|do not invent all day/i);
  assert.match(cj.ops_notes ?? "", /All You Can Eat|AYCE/);
  assert.match(cj.ops_notes ?? "", /Already in \/canton/);
  assert.match(cj.ops_notes ?? "", /Do not fold the crab house into a new view/i);

  const mon = cj.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = cj.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = cj.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = cj.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const hh = cj.deals.find((d) => d.happy_hour === true);
  assert.ok(mon && tue && wed && thu && hh, "expected four weekday plates + crab house HH");

  for (const row of [mon, tue, wed, thu]) {
    assert.equal(row.start, null);
    assert.equal(row.end, null);
    assert.equal(row.time_window, undefined, "do not invent all day");
    assert.equal(row.happy_hour, undefined);
  }

  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price]),
    [["Double crab cake platter with two sides $39.99", "$39.99"]],
  );
  assert.deepEqual(mon.food_categories, ["seafood/crab"]);
  assert.match(mon.proof_quote, /Double Crab Cake Platter/);
  assert.match(mon.proof_quote, /Served with two sides \$39\.99/);
  assert.equal(mon.source_url, "https://www.captainjameslanding.com/event/monday-double-crab-cake-platter/");

  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price]),
    [["Poboy (shrimp, steak, or fried oysters) with fries $12", "$12"]],
  );
  assert.deepEqual(tue.food_categories, ["sandwich/cheesesteak"]);
  assert.match(tue.proof_quote, /POBOYS/);
  assert.match(tue.proof_quote, /Shrimp, Steak, or Fried Oysters/);
  assert.match(tue.proof_quote, /served with fries \$12/);
  assert.equal(tue.source_url, "https://www.captainjameslanding.com/event/tuesday-poboys/");

  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price]),
    [["Lobster roll with homemade chips $25.00", "$25.00"]],
  );
  assert.deepEqual(wed.food_categories, ["seafood/crab"]);
  assert.match(wed.proof_quote, /Lobster Roll/);
  assert.match(wed.proof_quote, /Served with homemade chips \$25\.00/);
  assert.equal(wed.source_url, "https://www.captainjameslanding.com/event/wednesday-lobster-roll/");

  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price]),
    [["Whole fish with rice $32.00", "$32.00"]],
  );
  assert.deepEqual(thu.food_categories, ["seafood/crab"]);
  assert.match(thu.proof_quote, /Whole Fish/);
  assert.match(thu.proof_quote, /Served with rice \$32\.00/);
  assert.equal(thu.source_url, "https://www.captainjameslanding.com/event/thursday-whole-fish/");

  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "4pm-7pm");
  assert.equal(hh.prices_published, false);
  assert.deepEqual(hh.food_categories, ["drink"]);
  assert.match(hh.proof_quote, /Happy Hour at the Crab House/);
  assert.match(hh.proof_quote, /4PM -7PM Monday - Friday/);
  assert.match(hh.proof_quote, /Dine In only/);
  assert.equal(hh.source_url, "https://www.captainjameslanding.com/event/happy-hour-at-the-crab-house/");

  const allText = cj.deals.flatMap((d) => d.items.map((i) => i.text)).join(" | ");
  assert.doesNotMatch(allText, /All You Can Eat|\$48/);
  assert.doesNotMatch(allText, /Natty|Corona/i);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "captain-james-landing"));
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "captain-james-landing"));
  assert.equal(bySlug["crab-house"], undefined, "do not invent a crab house view");
});

test("Bertha's Soul Food joins 2026-08-19 (Belair-Edison, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bertha = byId["berthas-soul-food"];
  assert.ok(bertha, "berthas-soul-food missing");
  assert.deepEqual(venueShapeErrors(bertha), []);
  assert.equal(bertha.name, "Bertha's Soul Food");
  assert.equal(bertha.neighborhood, "Belair-Edison");
  assert.equal(
    bertha.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-19",
  );
  assert.equal(bertha.status, "verified");
  assert.equal(bertha.address, "4201 Belair Road, Baltimore, MD 21206");
  assert.equal(bertha.phone, "(443) 759-9701");
  assert.equal(bertha.source_url, "https://berthassoulfood.com/specials");
  assert.equal(bertha.source_type, "venue_website");
  assert.equal(bertha.last_verified, "2026-08-19");
  assert.equal(bertha.notes_public, undefined, "no dine-in / bar-only / cash-only on the specials page");
  assert.equal(bertha.lat, 39.327747);
  assert.equal(bertha.lon, -76.565704);
  assert.equal(bertha.deals.length, 5);
  assert.match(bertha.ops_notes ?? "", /Name=Belair-Edison/);
  assert.match(bertha.ops_notes ?? "", /Do not invent a Belair-Edison page/);
  assert.match(bertha.ops_notes ?? "", /Do not fold into \/canton/);
  assert.match(bertha.ops_notes ?? "", /JACK S8 HENNESSY/);
  assert.match(bertha.ops_notes ?? "", /ESPELON/);
  assert.match(bertha.ops_notes ?? "", /SOUL FOOD MENU EXTENDED UNTIL MIDNIGHT/);

  const tue = bertha.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const fri = bertha.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  const satBrunch = bertha.deals.find(
    (d) => d.days.length === 1 && d.days[0] === "sat" && d.start === 720,
  );
  const satLate = bertha.deals.find(
    (d) => d.days.length === 1 && d.days[0] === "sat" && d.start === 1260,
  );
  const sunBrunch = bertha.deals.find((d) => d.days.length === 1 && d.days[0] === "sun");
  assert.ok(tue && fri && satBrunch && satLate && sunBrunch, "expected five windows");

  assert.equal(tue.start, 1080);
  assert.equal(tue.end, 1260);
  assert.equal(tue.time_window, "6pm-9pm");
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["3 tacos for $10 (shrimp, beef, or fish / catfish or salmon)", "$10"],
      ["$2 off all tequila", "$2 off"],
      ["$20 flights", "$20"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["tacos", "drink"]);
  assert.match(tue.proof_quote, /Taco Tuesday/);
  assert.match(tue.proof_quote, /3 Tacos for \$10/);
  assert.match(tue.proof_quote, /Shrimp, Beef, or Fish \(catfish or salmon\)/);
  assert.match(tue.proof_quote, /\$2 off of all Tequila/);
  assert.match(tue.proof_quote, /\$20 Flights/);

  assert.equal(fri.start, 1260);
  assert.equal(fri.end, 1440);
  assert.equal(fri.time_window, "9pm-12am");
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$10 subs & fries", "$10"],
      ["$10 wings & fries", "$10"],
      ["$8 Long Islands", "$8"],
      ["$20 flights (lemon drop, margarita, green tea)", "$20"],
    ],
  );
  assert.deepEqual(fri.food_categories, ["sandwich/cheesesteak", "wings", "drink"]);
  assert.match(fri.proof_quote, /\$10 Subs & Fries/);
  assert.match(fri.proof_quote, /\$10 Wings & Fries/);
  assert.match(fri.proof_quote, /\$8 Long Islands/);
  assert.match(fri.proof_quote, /\$20 Flights \(Lemon drop, Margarita, Green Tea\)/);

  assert.equal(satBrunch.start, 720);
  assert.equal(satBrunch.end, 900);
  assert.equal(satBrunch.time_window, "12pm-3pm");
  assert.deepEqual(satBrunch.food_categories, ["brunch", "drink"]);
  assert.deepEqual(
    satBrunch.items.map((i) => [i.text, i.price ?? null]),
    [["$35 bottomless mimosas, 90 min limit", "$35"]],
  );
  assert.match(satBrunch.proof_quote, /Brunch Every Saturday/);
  assert.match(satBrunch.proof_quote, /\$35 Bottomless Mimosas/);
  assert.match(satBrunch.proof_quote, /90 min Limit/);

  assert.equal(satLate.start, 1260);
  assert.equal(satLate.end, 1440);
  assert.equal(satLate.time_window, "9pm-12am");
  assert.deepEqual(
    satLate.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$6 Tito's / Jameson / Crown / Jack", "$6"],
      ["$8 Hennessy / ESPELON", "$8"],
      ["$2 off Casamigos & Dusse", "$2 off"],
    ],
  );
  assert.deepEqual(satLate.food_categories, ["drink"]);
  assert.match(satLate.proof_quote, /JACK S8 HENNESSY/);
  assert.match(satLate.proof_quote, /ESPELON/);
  assert.match(satLate.proof_quote, /SOUL FOOD MENU EXTENDED UNTIL MIDNIGHT/);
  assert.doesNotMatch(
    satLate.items.map((i) => i.text).join(" | "),
    /SOUL FOOD MENU EXTENDED/,
    "midnight menu line is proof only, not its own deal",
  );

  assert.equal(sunBrunch.start, 720);
  assert.equal(sunBrunch.end, 960);
  assert.equal(sunBrunch.time_window, "12pm-4pm");
  assert.deepEqual(sunBrunch.food_categories, ["brunch", "drink"]);
  assert.deepEqual(
    sunBrunch.items.map((i) => [i.text, i.price ?? null]),
    [["$35 bottomless mimosas, 90 min limit", "$35"]],
  );
  assert.match(sunBrunch.proof_quote, /\$35 Bottomless Mimosas/);
  assert.match(sunBrunch.proof_quote, /90 min Limit/);

  const allText = bertha.deals.flatMap((d) => d.items.map((i) => i.text)).join(" | ");
  assert.match(allText, /ESPELON/);
  assert.match(allText, /90 min limit/);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "berthas-soul-food"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "berthas-soul-food"),
    "Belair-Edison must not fold into /canton",
  );
  assert.equal(bySlug["belair-edison"], undefined, "do not invent a Belair-Edison page");
});

test("Blue Pit BBQ joins 2026-08-19 (Hampden, Wed–Fri 3–6 happy hour)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const pit = byId["blue-pit-bbq"];
  assert.ok(pit, "blue-pit-bbq missing");
  assert.deepEqual(venueShapeErrors(pit), []);
  assert.equal(pit.name, "Blue Pit BBQ");
  assert.equal(pit.neighborhood, "Hampden");
  assert.equal(
    pit.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-19",
  );
  assert.equal(pit.status, "verified");
  assert.equal(pit.address, "1601 Union Ave, Baltimore, MD 21211");
  assert.equal(pit.phone, "(443) 948-5590");
  assert.equal(pit.source_url, "https://bluepitbbq.com/menu/");
  assert.equal(pit.source_type, "venue_website");
  assert.equal(pit.last_verified, "2026-08-19");
  assert.equal(pit.notes_public, undefined, "no dine-in / bar-only on the happy-hour block");
  assert.equal(pit.lat, 39.331849);
  assert.equal(pit.lon, -76.640820);
  assert.equal(pit.deals.length, 1);
  assert.match(pit.ops_notes ?? "", /Name=Hampden/);
  assert.match(pit.ops_notes ?? "", /Already in \/hampden/);
  assert.match(pit.ops_notes ?? "", /Do not invent IG 3–7|Do not invent IG 3-7/);
  assert.match(pit.ops_notes ?? "", /Flights & Bites|Heaven Hill|Buffalo Trace/);

  const hh = pit.deals[0];
  assert.deepEqual(hh.days, ["wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.equal(hh.source_url, "https://bluepitbbq.com/menu/");
  assert.deepEqual(hh.food_categories, ["sliders", "drink"]);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["1 slider $5 (pulled pork, pulled chicken, or chopped brisket with slaw)", "$5"],
      ["3 sliders $12", "$12"],
      ["Select draft beers $5", "$5"],
      ["Non-alcoholic beer $5", "$5"],
      ["Glasses of wine $5", "$5"],
      ["House Old Fashioned $7 (with Benchmark)", "$7"],
      ["Signature Mule $7", "$7"],
    ],
  );
  assert.match(hh.proof_quote, /Happy Hour/);
  assert.match(hh.proof_quote, /Every Wednesday/);
  assert.match(hh.proof_quote, /3 pm to 6 pm/);
  assert.match(hh.proof_quote, /1 Slider/);
  assert.match(hh.proof_quote, /Pulled Pork, Pulled Chicken or Chopped Brisket with Slaw/);
  assert.match(hh.proof_quote, /3 Sliders/);
  assert.match(hh.proof_quote, /Select Draft Beers/);
  assert.match(hh.proof_quote, /Non-Alcoholic Beer/);
  assert.match(hh.proof_quote, /Glasses of Wine/);
  assert.match(hh.proof_quote, /House Old Fashioned/);
  assert.match(hh.proof_quote, /with Benchmark/);
  assert.match(hh.proof_quote, /Signature Mule/);

  const allText = pit.deals.flatMap((d) => d.items.map((i) => i.text)).join(" | ");
  assert.doesNotMatch(allText, /Heaven Hill|Buffalo Trace|Flight|Fight/i);
  assert.doesNotMatch(allText, /3\s*[–-]\s*7/);
  assert.doesNotMatch(hh.time_window, /3\s*[–-]\s*7|3pm-7/);

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "blue-pit-bbq"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "blue-pit-bbq"));
});

test("Bunny's Buckets & Bubbles joins 2026-08-20 (Fells Point, two hoppy hours)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bunny = byId["bunnys-buckets"];
  assert.ok(bunny, "bunnys-buckets missing");
  assert.deepEqual(venueShapeErrors(bunny), []);
  assert.equal(bunny.name, "Bunny's Buckets & Bubbles");
  assert.equal(bunny.neighborhood, "Fells Point");
  assert.equal(
    bunny.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(bunny.status, "verified");
  assert.equal(bunny.address, "801 S Ann St, Baltimore, MD 21231");
  assert.equal(bunny.phone, "(443) 708-3861");
  assert.equal(
    bunny.source_url,
    "https://irp.cdn-website.com/2857e133/files/uploaded/bunnys_hoppy_hour_menu.pdf",
  );
  assert.equal(bunny.source_type, "venue_website");
  assert.equal(bunny.last_verified, "2026-08-20");
  assert.match(bunny.notes_public ?? "", /bar seating/i);
  assert.match(bunny.notes_public ?? "", /downstairs bar/i);
  assert.equal(bunny.lat, 39.282584);
  assert.equal(bunny.lon, -76.590993);
  assert.equal(bunny.deals.length, 2);
  assert.match(bunny.ops_notes ?? "", /image-only/i);
  assert.match(bunny.ops_notes ?? "", /2024-11-20/);
  assert.match(bunny.ops_notes ?? "", /Name=Fells Point/);
  assert.match(bunny.ops_notes ?? "", /Already in \/fells-point/);

  const weekday = bunny.deals.find((d) => d.days.includes("mon") && !d.days.includes("fri"));
  const friday = bunny.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.ok(weekday, "Mon–Thu hoppy hour missing");
  assert.ok(friday, "Friday hoppy hour missing");
  assert.deepEqual(weekday.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(weekday.start, 1020);
  assert.equal(weekday.end, 1080);
  assert.equal(weekday.time_window, "5pm-6pm");
  assert.equal(weekday.happy_hour, true);
  assert.deepEqual(friday.days, ["fri"]);
  assert.equal(friday.start, 960);
  assert.equal(friday.end, 1080);
  assert.equal(friday.time_window, "4pm-6pm");
  assert.equal(friday.happy_hour, true);
  assert.ok(
    !bunny.deals.some((d) => d.days.includes("sat") || d.days.includes("sun")),
    "do not invent Saturday/Sunday hoppy hour",
  );

  const expectedItems = [
    ["Fried chicken sandwich $8", "$8"],
    ["Shrimp & grits $8", "$8"],
    ["Chicken poutine $8", "$8"],
    ["Baby crab rice $8", "$8"],
    ["Chicken nuggies $8", "$8"],
    ["Caviar & chips $8", "$8"],
    ["Wine $6 (glass of red, white, or bubbles)", "$6"],
    ["Jessica Rabbit or Ramona Flowers $8", "$8"],
    ["Miller High Life bottles $3", "$3"],
    ["Veuve Clicquot $60 bottle", "$60"],
    ["Veuve Clicquot $20 glass", "$20"],
  ];
  const expectedCats = ["sandwich/cheesesteak", "seafood/crab", "small-plate/apps", "drink"];
  for (const row of [weekday, friday]) {
    assert.equal(
      row.source_url,
      "https://irp.cdn-website.com/2857e133/files/uploaded/bunnys_hoppy_hour_menu.pdf",
    );
    assert.deepEqual(row.food_categories, expectedCats);
    assert.ok(!row.food_categories.includes("seafood"));
    assert.deepEqual(
      row.items.map((i) => [i.text, i.price ?? null]),
      expectedItems,
    );
    assert.match(row.proof_quote, /BUNNY'S HOPPY HOUR/);
    assert.match(row.proof_quote, /bar seating and downstairs bar area/);
    assert.match(row.proof_quote, /Monday - Thursday 5pm - 6pm/);
    assert.match(row.proof_quote, /Friday from 4pm to 6pm/);
  }

  assert.ok(venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "bunnys-buckets"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "bunnys-buckets"));
});

test("Brewer's Cask joins 2026-08-20 (Federal Hill, four priced rows)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cask = byId["brewers-cask"];
  assert.ok(cask, "brewers-cask missing");
  assert.deepEqual(venueShapeErrors(cask), []);
  assert.equal(cask.name, "Brewer's Cask");
  assert.equal(cask.neighborhood, "Federal Hill");
  assert.equal(
    cask.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cask.status, "verified");
  assert.equal(cask.address, "1236 Light St, Baltimore, MD 21230");
  assert.equal(cask.phone, "(410) 273-9377");
  assert.equal(
    cask.source_url,
    "https://brewers-cask.com/baltimore-brewer-s-cask-happy-hours-specials",
  );
  assert.equal(cask.source_type, "venue_website");
  assert.equal(cask.last_verified, "2026-08-20");
  assert.equal(cask.notes_public, undefined);
  assert.equal(cask.lat, 39.2751037);
  assert.equal(cask.lon, -76.6123063);
  assert.equal(cask.deals.length, 4);
  assert.match(cask.ops_notes ?? "", /Name=Federal Hill/);
  assert.match(cask.ops_notes ?? "", /Already in \/federal-hill/);
  assert.match(cask.ops_notes ?? "", /Sat Happy Hour/);
  assert.match(cask.ops_notes ?? "", /Side Car Sides/);

  const weekdayHh = cask.deals.find((d) => d.days.includes("tue") && d.happy_hour === true);
  const monHh = cask.deals.find(
    (d) => d.days.length === 1 && d.days[0] === "mon" && d.happy_hour === true,
  );
  const trivia = cask.deals.find((d) => d.days.length === 1 && d.days[0] === "thu" && !d.happy_hour);
  const industry = cask.deals.find(
    (d) => d.days.length === 1 && d.days[0] === "mon" && d.happy_hour !== true,
  );
  assert.ok(weekdayHh && monHh && trivia && industry, "expected four windows");

  assert.deepEqual(weekdayHh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(weekdayHh.start, 900);
  assert.equal(weekdayHh.end, 1080);
  assert.equal(weekdayHh.time_window, "3pm-6pm");
  assert.deepEqual(
    weekdayHh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 Drafts", "$5"],
      ["$3 of Appetizers", "$3"],
    ],
  );
  assert.deepEqual(weekdayHh.food_categories, ["drink", "small-plate/apps"]);
  assert.match(weekdayHh.proof_quote, /\$3 of Appetizers/);

  assert.deepEqual(monHh.days, ["mon"]);
  assert.equal(monHh.start, 1020);
  assert.equal(monHh.end, 1380);
  assert.equal(monHh.time_window, "5pm-11pm");
  assert.deepEqual(
    monHh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 Drafts", "$5"],
      ["$3 of Appetizers", "$3"],
    ],
  );

  assert.equal(trivia.start, 1140);
  assert.equal(trivia.end, null);
  assert.equal(trivia.time_window, "7pm-1am");
  assert.equal(trivia.happy_hour, undefined);
  assert.deepEqual(trivia.items.map((i) => [i.text, i.price ?? null]), [["$5 Off Burgers", "$5 off"]]);
  assert.deepEqual(trivia.food_categories, ["burger"]);

  assert.equal(industry.start, 1020);
  assert.equal(industry.end, 1380);
  assert.equal(industry.time_window, "5pm-11pm");
  assert.equal(industry.happy_hour, undefined);
  assert.deepEqual(
    industry.items.map((i) => [i.text, i.price ?? null]),
    [["$10 beer & wings", "$10"]],
  );
  assert.deepEqual(industry.food_categories, ["drink", "wings"]);

  assert.ok(
    !cask.deals.some((d) => d.days.includes("sat") || d.days.includes("sun")),
    "do not invent Saturday unpriced HH or Sunday",
  );

  assert.ok(venuesInView(venues, bySlug["federal-hill"]).some((v) => v.id === "brewers-cask"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "brewers-cask"));
});

test("Charles Village Pub joins 2026-08-20 (Charles Village, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cvp = byId["charles-village-pub"];
  assert.ok(cvp, "charles-village-pub missing");
  assert.deepEqual(venueShapeErrors(cvp), []);
  assert.equal(cvp.name, "Charles Village Pub");
  assert.equal(cvp.neighborhood, "Charles Village");
  assert.equal(
    cvp.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cvp.status, "verified");
  assert.equal(cvp.address, "3107 St. Paul St, Baltimore, MD 21218");
  assert.equal(cvp.phone, "(410) 243-1611");
  assert.equal(cvp.source_url, "https://charlesvillagepubbaltimore.com/weekly-specials.html");
  assert.equal(cvp.source_type, "venue_website");
  assert.equal(cvp.last_verified, "2026-08-20");
  assert.equal(cvp.notes_public, undefined);
  assert.equal(cvp.lat, 39.3261512);
  assert.equal(cvp.lon, -76.6155528);
  assert.equal(cvp.deals.length, 6);
  assert.match(cvp.ops_notes ?? "", /Name=Charles Village/);
  assert.match(cvp.ops_notes ?? "", /Do not invent a charles-village view/);
  assert.match(cvp.ops_notes ?? "", /Do not fold into \/station-north/);
  assert.match(cvp.ops_notes ?? "", /Last-Modified 2020-06-14/);
  assert.match(cvp.ops_notes ?? "", /\$2\.oo/);
  assert.ok(
    !cvp.deals.some((d) => d.days.includes("fri")),
    "Friday HAPPY HOUR FROM 4:00-6:30 has no $ — pin no fri deal",
  );

  const sun = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "sun");
  const mon = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const sat = cvp.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.ok(sun && mon && tue && wed && thu && sat, "expected six windows");

  assert.equal(sun.start, 660);
  assert.equal(sun.end, 840);
  assert.equal(sun.time_window, "11am-2pm");
  assert.deepEqual(sun.items.map((i) => [i.text, i.price ?? null]), [["$3 mimosas", "$3"]]);
  assert.deepEqual(sun.food_categories, ["brunch", "drink"]);

  assert.equal(mon.start, 1140);
  assert.equal(mon.end, null);
  assert.equal(mon.time_window, "7-close");
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [["$10 Domestic Buckets O' Beer", "$10"]],
  );
  assert.doesNotMatch(mon.items.map((i) => i.text).join(" | "), /skybox/i);

  assert.equal(tue.start, null);
  assert.equal(tue.end, null);
  assert.equal(tue.time_window, undefined, "do not invent a Tuesday clock");
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [["13oz Burger-$3.00 off!", "$3 off"]],
  );
  assert.deepEqual(tue.food_categories, ["burger"]);

  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$1.00 OFF ALL DRAFTS", "$1 off"],
      ["$1.00 off every rack", "$1 off"],
      ["$2.oo off every rack and a half", "$2 off"],
    ],
  );
  assert.match(wed.items[2].text, /\$2\.oo/);
  assert.deepEqual(wed.food_categories, ["drink"]);

  assert.equal(thu.start, null);
  assert.equal(thu.end, null);
  assert.equal(thu.time_window, undefined, "one Thursday row — no invented clock");
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$11.95 10 oz NY Strip and choice of side", "$11.95"],
      ["$3.00 PBR TALL BOYS ALL NIGHT!", "$3"],
    ],
  );
  assert.deepEqual(thu.food_categories, ["steak", "drink"]);

  assert.equal(sat.start, 1320);
  assert.equal(sat.end, null);
  assert.equal(sat.time_window, "10-close");
  assert.equal(sat.happy_hour, true);
  assert.deepEqual(
    sat.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$4 Drafts", "$4"],
      ["$3 bottles", "$3"],
    ],
  );

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "charles-village-pub"));
  assert.ok(
    !venuesInView(venues, bySlug["station-north"]).some((v) => v.id === "charles-village-pub"),
    "Charles Village must not fold into /station-north",
  );
  assert.ok(
    !venuesInView(venues, bySlug["mount-vernon"]).some((v) => v.id === "charles-village-pub"),
    "Charles Village must not fold into /mount-vernon",
  );
  assert.equal(bySlug["charles-village"], undefined, "do not invent a charles-village view");
});

test("Chuck's Trading Post joins 2026-08-20 (Hampden, Wednesday burger night)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const chucks = byId["chucks-trading-post"];
  assert.ok(chucks, "chucks-trading-post missing");
  assert.deepEqual(venueShapeErrors(chucks), []);
  assert.equal(chucks.name, "Chuck's Trading Post");
  assert.equal(chucks.neighborhood, "Hampden");
  assert.equal(
    chucks.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(chucks.status, "verified");
  assert.equal(chucks.address, "1506 W 36th St, Baltimore, MD 21211");
  assert.equal(chucks.phone, "(410) 366-0178");
  assert.equal(chucks.source_url, "https://www.chuckstradingpost.com/");
  assert.equal(chucks.source_type, "venue_website");
  assert.equal(chucks.last_verified, "2026-08-20");
  assert.equal(chucks.notes_public, undefined);
  assert.equal(chucks.lat, 39.3301604);
  assert.equal(chucks.lon, -76.6394985);
  assert.equal(chucks.deals.length, 1);
  assert.match(chucks.ops_notes ?? "", /Name=Hampden/);
  assert.match(chucks.ops_notes ?? "", /Already in \/hampden/);
  assert.match(chucks.ops_notes ?? "", /Thirsty Thursday/);
  assert.match(chucks.ops_notes ?? "", /August 11, 2026/);

  const wed = chucks.deals[0];
  assert.deepEqual(wed.days, ["wed"]);
  assert.equal(wed.start, 1020);
  assert.equal(wed.end, 1200);
  assert.equal(wed.time_window, "5pm-8pm");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["(Burger, Fries, and 1 beer) $15", "$15"]],
  );
  assert.deepEqual(wed.food_categories, ["burger", "drink"]);
  assert.match(wed.proof_quote, /BURGER NIGHT/);
  assert.ok(
    !chucks.deals.some((d) => d.days.includes("thu")),
    "Thirsty Thursday has no $",
  );

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "chucks-trading-post"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "chucks-trading-post"));
});

test("Cinghiale joins 2026-08-20 (Harbor East, Cellar Raid only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cg = byId.cinghiale;
  assert.ok(cg, "cinghiale missing");
  assert.deepEqual(venueShapeErrors(cg), []);
  assert.equal(cg.name, "Cinghiale");
  assert.equal(cg.neighborhood, "Harbor East");
  assert.equal(
    cg.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cg.status, "verified");
  assert.equal(cg.address, "822 Lancaster St, Baltimore, MD 21202");
  assert.equal(cg.phone, "(410) 547-8282");
  assert.equal(cg.source_url, "https://www.cgeno.com/specials-and-events");
  assert.equal(cg.source_type, "venue_website");
  assert.equal(cg.last_verified, "2026-08-20");
  assert.match(cg.notes_public ?? "", /Enoteca or bar/i);
  assert.match(cg.notes_public ?? "", /lunch and dinner/i);
  assert.equal(cg.lat, 39.2824892);
  assert.equal(cg.lon, -76.6008354);
  assert.equal(cg.deals.length, 1);
  assert.match(cg.ops_notes ?? "", /Name=Harbor East/);
  assert.match(cg.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(cg.ops_notes ?? "", /CG_HH\.pdf/);
  assert.match(cg.ops_notes ?? "", /2026-07-22/);
  assert.match(cg.ops_notes ?? "", /Not this ticket/);

  const raid = cg.deals[0];
  assert.deepEqual(raid.days, ["tue"]);
  assert.equal(raid.start, null);
  assert.equal(raid.end, null);
  assert.equal(raid.time_window, "Lunch and Dinner");
  assert.doesNotMatch(raid.time_window, /all day/i);
  assert.deepEqual(
    raid.items.map((i) => [i.text, i.price ?? null]),
    [["50% off all of bottles of wine", "50% off"]],
  );
  assert.match(raid.items[0].text, /all of bottles/);
  assert.deepEqual(raid.food_categories, ["drink"]);
  assert.match(raid.proof_quote, /50% off all of bottles of wine/);
  assert.match(raid.proof_quote, /Lunch and Dinner/);

  assert.ok(
    !cg.deals.some(
      (d) =>
        d.happy_hour === true ||
        /4-6|4pm-6/i.test(d.time_window ?? "") ||
        (d.start === 960 && d.end === 1080),
    ),
    "do not load daily 4–6 HH from the unpriced specials copy",
  );

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "cinghiale"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "cinghiale"));
  assert.equal(bySlug["harbor-east"], undefined, "do not invent a Harbor East-only view");
});

test("Clasé Lounge joins 2026-08-20 (Morrell Park, Wednesday only, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const clase = byId["clase-lounge"];
  assert.ok(clase, "clase-lounge missing");
  assert.deepEqual(venueShapeErrors(clase), []);
  assert.equal(clase.name, "Clasé Lounge");
  assert.equal(clase.neighborhood, "Morrell Park");
  assert.equal(
    clase.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(clase.status, "verified");
  assert.equal(clase.address, "2709 Washington Blvd, Baltimore, MD 21230");
  assert.equal(clase.phone, "(443) 835-2421");
  assert.equal(clase.source_url, "https://claselounge.com/");
  assert.equal(clase.source_type, "venue_website");
  assert.equal(clase.last_verified, "2026-08-20");
  assert.equal(clase.notes_public, undefined);
  assert.equal(clase.lat, 39.2644395);
  assert.equal(clase.lon, -76.654678);
  assert.equal(clase.deals.length, 2);
  assert.match(clase.ops_notes ?? "", /Name=Morrell Park/);
  assert.match(clase.ops_notes ?? "", /Do not invent a morrell-park view/);
  assert.match(clase.ops_notes ?? "", /Do not fold into \/federal-hill/);
  assert.match(clase.ops_notes ?? "", /Satuday/);
  assert.match(clase.ops_notes ?? "", /do not drop Wednesday 5pm/i);
  assert.match(clase.ops_notes ?? "", /Jump Off Sundays/);
  assert.match(clase.ops_notes ?? "", /HOLD/);
  assert.ok(
    !clase.deals.some((d) => d.days.includes("sun")),
    "Jump Off Sundays is HOLD — pin no sun deal",
  );
  assert.ok(
    !clase.deals.some((d) => d.days.includes("thu") || d.days.includes("sat")),
    "Throwback Thursdays and Grown & Sexy Saturdays have no food/drink $",
  );

  const rush = clase.deals.find((d) => d.start === 1020);
  const wild = clase.deals.find((d) => d.start === 1260);
  assert.ok(rush && wild, "expected two Wednesday windows");
  assert.deepEqual(rush.days, ["wed"]);
  assert.equal(rush.end, 1260);
  assert.equal(rush.time_window, "5pm-9pm");
  assert.equal(rush.happy_hour, true);
  assert.deepEqual(
    rush.items.map((i) => [i.text, i.price ?? null]),
    [
      ["2-for-1 drinks", "2-for-1"],
      ["$7 shots", "$7"],
      ["$1 wings", "$1"],
    ],
  );
  assert.deepEqual(rush.food_categories, ["drink", "wings"]);
  assert.match(rush.proof_quote, /2-for-1 drinks/);

  assert.deepEqual(wild.days, ["wed"]);
  assert.equal(wild.end, 1440);
  assert.equal(wild.time_window, "9pm-12am");
  assert.equal(wild.happy_hour, undefined);
  assert.deepEqual(
    wild.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 shots", "$5"],
      ["$1 wings", "$1"],
    ],
  );
  assert.deepEqual(wild.food_categories, ["drink", "wings"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "clase-lounge"));
  assert.ok(
    !venuesInView(venues, bySlug["federal-hill"]).some((v) => v.id === "clase-lounge"),
    "Morrell Park must not fold into /federal-hill",
  );
  assert.ok(
    !venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "clase-lounge"),
    "Morrell Park must not fold into /locust-point",
  );
  assert.equal(bySlug["morrell-park"], undefined, "do not invent a morrell-park view");
});

test("CookHouse joins 2026-08-20 (Bolton Hill, Wednesday steak & wine, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cook = byId.cookhouse;
  assert.ok(cook, "cookhouse missing");
  assert.deepEqual(venueShapeErrors(cook), []);
  assert.equal(cook.name, "CookHouse");
  assert.equal(cook.neighborhood, "Bolton Hill");
  assert.equal(
    cook.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cook.status, "verified");
  assert.equal(cook.address, "1501 Bolton St, Baltimore, MD 21217");
  assert.equal(cook.phone, "(410) 225-9964");
  assert.equal(cook.source_url, "https://cookhousecafebar.com/");
  assert.equal(cook.source_type, "venue_website");
  assert.equal(cook.last_verified, "2026-08-20");
  assert.equal(cook.notes_public, undefined);
  assert.equal(cook.lat, 39.3071688);
  assert.equal(cook.lon, -76.6258809);
  assert.equal(cook.deals.length, 1);
  assert.match(cook.ops_notes ?? "", /Name=Bolton Hill/);
  assert.match(cook.ops_notes ?? "", /Do not invent a bolton-hill view/);
  assert.match(cook.ops_notes ?? "", /50% of/);
  assert.match(cook.ops_notes ?? "", /50% off/);
  assert.match(cook.ops_notes ?? "", /Saturday After Hour Cocktails/);

  const wed = cook.deals[0];
  assert.deepEqual(wed.days, ["wed"]);
  assert.equal(wed.start, 1080);
  assert.equal(wed.end, 1320);
  assert.equal(wed.time_window, "6pm-10pm");
  assert.equal(wed.happy_hour, undefined);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$34 Steak Frites", "$34"],
      ["50% off All Wine Bottles", "50% off"],
    ],
  );
  assert.deepEqual(wed.food_categories, ["steak", "drink"]);
  assert.ok(
    !cook.deals.some((d) => d.days.includes("sat")),
    "Saturday After Hour Cocktails has no $",
  );

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "cookhouse"));
  for (const slug of ["hampden", "federal-hill", "locust-point", "inner-harbor", "station-north", "mount-vernon"]) {
    assert.ok(
      !venuesInView(venues, bySlug[slug]).some((v) => v.id === "cookhouse"),
      `Bolton Hill must not fold into /${slug}`,
    );
  }
  assert.equal(bySlug["bolton-hill"], undefined, "do not invent a bolton-hill view");
});

test("Cosima joins 2026-08-20 (Jones Falls Area, Tues–Sat 4–7 happy hour, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cosima = byId.cosima;
  assert.ok(cosima, "cosima missing");
  assert.deepEqual(venueShapeErrors(cosima), []);
  assert.equal(cosima.name, "Cosima");
  assert.equal(cosima.neighborhood, "Jones Falls Area");
  assert.equal(
    cosima.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cosima.status, "verified");
  assert.equal(cosima.address, "3000 Falls Road, Mill No. 1, Baltimore, MD 21211");
  assert.equal(cosima.phone, "(443) 708-7352");
  assert.equal(
    cosima.source_url,
    "https://www.cosimamill1.com/s/NEW-VERSION-Happy-Hour-Menu-Book-Format-42826.pdf",
  );
  assert.equal(cosima.source_type, "venue_website");
  assert.equal(cosima.last_verified, "2026-08-20");
  assert.equal(cosima.notes_public, undefined);
  assert.equal(cosima.lat, 39.3230125);
  assert.equal(cosima.lon, -76.6305904);
  assert.equal(cosima.deals.length, 1);
  assert.match(cosima.ops_notes ?? "", /Name=Jones Falls Area/);
  assert.match(cosima.ops_notes ?? "", /Do not invent a jones-falls-area view/);
  assert.match(cosima.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(cosima.ops_notes ?? "", /4-5 Tuesday-Saturday/);
  assert.match(cosima.ops_notes ?? "", /Do not invent a 4–5-only row/);

  const hh = cosima.deals[0];
  assert.deepEqual(hh.days, ["tue", "wed", "thu", "fri", "sat"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "4pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Negronis & Spritzes $5", "$5"],
      ["Arancina $9*", "$9"],
      ["Venticello $8", "$8"],
      ["Wine $7", "$7"],
      ["Beer $5", "$5"],
      ["Warm baguette $6", "$6"],
      ["Garlic bread $10", "$10"],
      ["Formaggio $14", "$14"],
      ["Olive fritte $8", "$8"],
      ["Ripieni di tonno $10", "$10"],
      ["Fritto misto $18", "$18"],
      ["Pinsa romana $12", "$12"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps", "pizza"]);
  assert.match(hh.proof_quote, /ARANCINA 9\*/);
  assert.ok(
    !cosima.deals.some((d) => d.start === 960 && d.end === 1020),
    "do not invent a 4–5-only row from the homepage footnote",
  );
  assert.ok(!cosima.deals.some((d) => d.days.includes("sun") || d.days.includes("mon")));

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "cosima"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "cosima"),
    "Jones Falls Area must not fold into /hampden",
  );
  assert.equal(bySlug["jones-falls-area"], undefined, "do not invent a jones-falls-area view");
});

test("Cypriana joins 2026-08-20 (Tuscany-Canterbury, weeknight HH + Wed/Thu/Sun extras, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cyp = byId.cypriana;
  assert.ok(cyp, "cypriana missing");
  assert.deepEqual(venueShapeErrors(cyp), []);
  assert.equal(cyp.name, "Cypriana");
  assert.equal(cyp.neighborhood, "Tuscany-Canterbury");
  assert.equal(
    cyp.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(cyp.status, "verified");
  assert.equal(cyp.address, "105 West 39th Street, Baltimore, MD 21210");
  assert.equal(cyp.phone, "(410)-837-PITA");
  assert.equal(
    cyp.source_url,
    "https://cypriana.com/baltimore-hampden-cypriana-restaurant-happy-hours-specials",
  );
  assert.equal(cyp.source_type, "venue_website");
  assert.equal(cyp.last_verified, "2026-08-20");
  assert.equal(cyp.notes_public, undefined);
  assert.equal(cyp.lat, 39.335977);
  assert.equal(cyp.lon, -76.621456);
  assert.equal(cyp.deals.length, 4);
  assert.match(cyp.ops_notes ?? "", /Name=Tuscany-Canterbury/);
  assert.match(cyp.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(cyp.ops_notes ?? "", /Do not pin the license street/);
  assert.match(cyp.ops_notes ?? "", /Street-food Sunday/);
  assert.ok(!cyp.deals.some((d) => d.days.includes("mon")), "Monday is closed — do not invent");
  assert.ok(!cyp.deals.some((d) => d.days.includes("sat")), "no Saturday card this week");
  assert.ok(
    !cyp.deals.some((d) => d.items.some((i) => /Street-food/i.test(i.text))),
    "Street-food Sunday has no $",
  );

  const hh = cyp.deals.find((d) => d.happy_hour === true);
  const wine = cyp.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const martini = cyp.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const burgers = cyp.deals.find((d) => d.days.length === 1 && d.days[0] === "sun");
  assert.ok(hh && wine && martini && burgers, "expected four priced rows");
  assert.deepEqual(hh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 1020);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "5pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["1/2 Price MEZZES", "1/2 price"],
      ["$2 OFF all cocktails and wine", "$2 off"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["small-plate/apps", "drink"]);
  assert.match(hh.proof_quote, /1\/2 Price MEZZES/);

  assert.equal(wine.start, 1020);
  assert.equal(wine.end, 1260);
  assert.equal(wine.time_window, "5pm-9pm");
  assert.equal(wine.happy_hour, undefined);
  assert.equal(
    wine.items[0].text,
    "All WINE BOTTLES $50 and up, half price!!! (some exclusions apply)",
  );
  assert.equal(wine.items[0].price, "50% off");
  assert.deepEqual(wine.food_categories, ["drink"]);

  assert.equal(martini.start, 1020);
  assert.equal(martini.end, 1260);
  assert.equal(martini.time_window, "5pm-9pm");
  assert.equal(martini.items[0].text, "1/2 priced Martinis at the bar, all night!");
  assert.equal(martini.items[0].price, "1/2 price");

  assert.equal(burgers.start, 1020);
  assert.equal(burgers.end, 1260);
  assert.equal(burgers.time_window, "5pm-9pm");
  assert.deepEqual(
    burgers.items.map((i) => [i.text, i.price ?? null]),
    [["Burgers at the Bar", "$20"]],
  );
  assert.deepEqual(burgers.food_categories, ["burger"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "cypriana"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "cypriana"),
    "Tuscany-Canterbury must not fold into /hampden",
  );
});

test("Don Tigre Mexican Grill joins 2026-08-20 (Riverside / locust-point, Taco Tuesday + 18% off)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const don = byId["don-tigre"];
  assert.ok(don, "don-tigre missing");
  assert.deepEqual(venueShapeErrors(don), []);
  assert.equal(don.name, "Don Tigre Mexican Grill");
  assert.equal(don.neighborhood, "Riverside");
  assert.equal(
    don.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(don.status, "verified");
  assert.equal(don.address, "900 E Fort Ave Suite 105, Baltimore, MD 21230");
  assert.equal(don.phone, "(301) 701-5464");
  assert.equal(don.source_url, "https://www.dontigremexicancuisine.com/");
  assert.equal(don.source_type, "venue_website");
  assert.equal(don.last_verified, "2026-08-20");
  assert.equal(don.notes_public, undefined);
  assert.equal(don.lat, 39.271781);
  assert.equal(don.lon, -76.6008455);
  assert.equal(don.deals.length, 2);
  assert.match(don.ops_notes ?? "", /Name=Riverside/);
  assert.match(don.ops_notes ?? "", /\+14434384450/);
  assert.match(don.ops_notes ?? "", /do not swap the public phone/i);
  assert.match(don.ops_notes ?? "", /Do not invent Owings Mills/);
  assert.match(don.ops_notes ?? "", /arbacoa/);
  assert.match(don.ops_notes ?? "", /captus/);
  assert.ok(!don.deals.some((d) => d.days.includes("mon")), "no Monday");
  assert.ok(
    !don.deals.some((d) => d.items.some((i) => /10% OFF Online/i.test(i.text))),
    "10% OFF Online only is not a weekly door deal",
  );

  const tacos = don.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const menu = don.deals.find((d) => d.days.includes("wed"));
  assert.ok(tacos && menu, "expected taco Tuesday and whole-menu rows");
  assert.equal(tacos.start, 720);
  assert.equal(tacos.end, 1290);
  assert.equal(tacos.time_window, "12pm-9:30pm");
  assert.deepEqual(
    tacos.items.map((i) => [i.text, i.price ?? null]),
    [["Taco Tuesday Special", "$11"]],
  );
  assert.deepEqual(tacos.food_categories, ["tacos"]);
  assert.match(tacos.proof_quote, /arbacoa/);
  assert.match(tacos.proof_quote, /captus/);

  assert.deepEqual(menu.days, ["wed", "thu", "fri", "sat", "sun"]);
  assert.equal(menu.start, 1020);
  assert.equal(menu.end, 1140);
  assert.equal(menu.time_window, "5pm-7pm");
  assert.deepEqual(
    menu.items.map((i) => [i.text, i.price ?? null]),
    [["18% off on the whole menu", "18% off"]],
  );
  assert.equal(menu.food_categories, undefined, "whole menu is not one vocab tag");

  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "don-tigre"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "don-tigre"));
  assert.equal(bySlug.riverside, undefined, "do not invent a Riverside-only view");
});

test("Dutch Courage joins 2026-08-20 (Old Goucher, M–F 4–6 happy hour, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const dutch = byId["dutch-courage"];
  assert.ok(dutch, "dutch-courage missing");
  assert.deepEqual(venueShapeErrors(dutch), []);
  assert.equal(dutch.name, "Dutch Courage");
  assert.equal(dutch.neighborhood, "Old Goucher");
  assert.equal(
    dutch.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(dutch.status, "verified");
  assert.equal(dutch.address, "2229 N. Charles Street, Baltimore, MD 21218");
  assert.equal(dutch.phone, "(667) 309-7167");
  assert.equal(
    dutch.source_url,
    "https://dutchcouragebar.com/wp-content/uploads/2026/04/HH2Menu.pdf",
  );
  assert.equal(dutch.source_type, "venue_website");
  assert.equal(dutch.last_verified, "2026-08-20");
  assert.equal(dutch.notes_public, undefined);
  assert.equal(dutch.lat, 39.3151574);
  assert.equal(dutch.lon, -76.6164641);
  assert.equal(dutch.deals.length, 1);
  assert.match(dutch.ops_notes ?? "", /Name=Old Goucher/);
  assert.match(dutch.ops_notes ?? "", /Do not invent an old-goucher view/);
  assert.match(dutch.ops_notes ?? "", /Do not fold into \/station-north or \/mount-vernon/);
  assert.match(dutch.ops_notes ?? "", /image-only/);
  assert.match(dutch.ops_notes ?? "", /2026-04-22|22 Apr 2026/);
  assert.match(dutch.ops_notes ?? "", /no \$ on that footer/);

  const hh = dutch.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "4pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Daily Featured Cocktail or House G&T $8", "$8"],
      ["$2 off all our beer and wine", "$2 off"],
      ["$2 off snacks", "$2 off"],
      ["Kale Salad $14", "$14"],
      ["MD Crab Dip $20", "$20"],
      ["Patatas Bravas $13", "$13"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps", "seafood/crab"]);
  assert.ok(!dutch.deals.some((d) => d.days.includes("sat") || d.days.includes("sun")));

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "dutch-courage"));
  assert.ok(
    !venuesInView(venues, bySlug["station-north"]).some((v) => v.id === "dutch-courage"),
    "Old Goucher must not fold into /station-north",
  );
  assert.ok(
    !venuesInView(venues, bySlug["mount-vernon"]).some((v) => v.id === "dutch-courage"),
    "Old Goucher must not fold into /mount-vernon",
  );
  assert.equal(bySlug["old-goucher"], undefined, "do not invent an old-goucher view");
});

test("Dylan's Oyster Cellar joins 2026-08-20 (Hampden, weekday drinks + Tue–Thu oysters)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const dylan = byId["dylans-oyster-cellar"];
  assert.ok(dylan, "dylans-oyster-cellar missing");
  assert.deepEqual(venueShapeErrors(dylan), []);
  assert.equal(dylan.name, "Dylan's Oyster Cellar");
  assert.equal(dylan.neighborhood, "Hampden");
  assert.equal(
    dylan.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(dylan.status, "verified");
  assert.equal(dylan.address, "3601 Chestnut Avenue, Baltimore, MD 21211");
  assert.equal(dylan.phone, "(443) 759-6595");
  assert.equal(dylan.source_url, "https://dylansoyster.com/");
  assert.equal(dylan.source_type, "venue_website");
  assert.equal(dylan.last_verified, "2026-08-20");
  assert.equal(dylan.notes_public, undefined);
  assert.equal(dylan.lat, 39.3313518);
  assert.equal(dylan.lon, -76.6291481);
  assert.equal(dylan.deals.length, 2);
  assert.match(dylan.ops_notes ?? "", /Name=Hampden/);
  assert.match(dylan.ops_notes ?? "", /Already in \/hampden/);
  assert.match(dylan.ops_notes ?? "", /Summer Break/);
  assert.match(dylan.ops_notes ?? "", /Do not hold the weekly rows/);
  assert.ok(
    !dylan.deals.some((d) => d.status === "held"),
    "summer-break banner ended Aug 18 — do not hold weekly rows",
  );

  const drinks = dylan.deals.find((d) => d.food_categories?.includes("drink"));
  const oysters = dylan.deals.find((d) => d.food_categories?.includes("seafood/crab"));
  assert.ok(drinks && oysters, "expected drinks and oyster happy hours");
  assert.deepEqual(drinks.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(drinks.start, 1020);
  assert.equal(drinks.end, 1140);
  assert.equal(drinks.time_window, "5pm-7pm");
  assert.equal(drinks.happy_hour, true);
  assert.deepEqual(
    drinks.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$1 off Drafts", "$1 off"],
      ["*$8 select Sparkling / Rosé/ White", "$8"],
      ["$8 High & Mellow(High Life PONY & a SHOT)", "$8"],
      ["$5 Pickle Back", "$5"],
    ],
  );
  assert.ok(!drinks.days.includes("sat"), "drink HH excludes Saturday");

  assert.deepEqual(oysters.days, ["tue", "wed", "thu"]);
  assert.equal(oysters.start, 1020);
  assert.equal(oysters.end, 1140);
  assert.equal(oysters.time_window, "5pm-7pm");
  assert.equal(oysters.happy_hour, true);
  assert.equal(
    oysters.items[0].text,
    "$5 off the a half dozen of the “Oyster of the Day”",
  );
  assert.equal(oysters.items[0].price, "$5 off");
  assert.ok(
    !oysters.days.includes("fri") && !oysters.days.includes("sat"),
    "oyster HH except Friday & Saturday",
  );

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "dylans-oyster-cellar"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "dylans-oyster-cellar"));
});

test("Facci Ristorante joins 2026-08-20 (Otterbein, daily 3–6 bar-only HH, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const facci = byId.facci;
  assert.ok(facci, "facci missing");
  assert.deepEqual(venueShapeErrors(facci), []);
  assert.equal(facci.name, "Facci Ristorante");
  assert.equal(facci.neighborhood, "Otterbein");
  assert.equal(
    facci.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(facci.status, "verified");
  assert.equal(facci.address, "414 Light Street, Baltimore, MD 21202");
  assert.equal(facci.phone, "(443) 835-2789");
  assert.equal(facci.source_url, "https://faccirestaurant.com/happy-hour/");
  assert.equal(facci.source_type, "venue_website");
  assert.equal(facci.last_verified, "2026-08-20");
  assert.equal(facci.notes_public, "Happy hour is at the bar only, 3–6pm daily.");
  assert.equal(facci.lat, 39.283737);
  assert.equal(facci.lon, -76.6137484);
  assert.equal(facci.deals.length, 1);
  assert.match(facci.ops_notes ?? "", /Name=Otterbein/);
  assert.match(facci.ops_notes ?? "", /Do not invent an otterbein view|Do not invent a \/otterbein/);
  assert.match(facci.ops_notes ?? "", /Do not fold into \/inner-harbor/);
  assert.match(facci.ops_notes ?? "", /3 – 6P/);
  assert.match(facci.ops_notes ?? "", /BRUSSEL/);
  assert.match(facci.ops_notes ?? "", /835 2765/);
  assert.match(facci.ops_notes ?? "", /do not swap/i);

  const hh = facci.deals[0];
  assert.deepEqual(hh.days, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Facci Martini $11", "$11"],
      ["Facci Margarita $11", "$11"],
      ["Figgin Peachy $12", "$12"],
      ["Bada Bing $12", "$12"],
      ["Sangria $10", "$10"],
      ["Lemon Drop Martini $12", "$12"],
      ["Wine by the glass $1 off", "$1 off"],
      ["$2 off draft & bottle beers", "$2 off"],
      ["Parmesan Brussel Sprouts $13", "$13"],
      ["Mozzarella Caprese $12", "$12"],
      ["Facci Bruschetta $8", "$8"],
      ["Shrimp & Bacon $15", "$15"],
      ["Polpette della Casa $12", "$12"],
      ["Smash Burger Slider $15", "$15"],
      ["Pomodori & Quattro Formaggi Flat Bread $10", "$10"],
    ],
  );
  assert.ok(hh.items.some((i) => /Brussel/.test(i.text)), "keep site wording BRUSSEL (not Brussels)");
  assert.deepEqual(hh.food_categories, [
    "drink",
    "small-plate/apps",
    "seafood/crab",
    "burger",
    "sliders",
    "pizza",
  ]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "facci"));
  assert.ok(
    !venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "facci"),
    "Otterbein must not fold into /inner-harbor",
  );
  assert.equal(bySlug.otterbein, undefined, "do not invent an otterbein view");
});

test("Fogo de Chao joins 2026-08-20 (Inner Harbor, all-day Bar Fogo + half-price wine bottles)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const fogo = byId["fogo-de-chao"];
  assert.ok(fogo, "fogo-de-chao missing");
  assert.deepEqual(venueShapeErrors(fogo), []);
  assert.equal(fogo.name, "Fogo de Chao");
  assert.equal(fogo.neighborhood, "Inner Harbor");
  assert.equal(
    fogo.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(fogo.status, "verified");
  assert.equal(fogo.address, "600 E. Pratt St. #102, Baltimore, MD 21202");
  assert.equal(fogo.phone, "(410) 528-9292");
  assert.equal(fogo.source_url, "https://fogodechao.com/location/baltimore/");
  assert.equal(fogo.source_type, "venue_website");
  assert.equal(fogo.last_verified, "2026-08-20");
  assert.equal(
    fogo.notes_public,
    "All-day drink happy hour is at Bar Fogo. Half-price South American wine bottles under $130 are in the dining room and bar.",
  );
  assert.equal(fogo.lat, 39.2872129);
  assert.equal(fogo.lon, -76.6073897);
  assert.equal(fogo.deals.length, 2);
  assert.match(fogo.ops_notes ?? "", /Name=Inner Harbor/);
  assert.match(fogo.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(fogo.ops_notes ?? "", /Caipirinha/);
  assert.match(fogo.ops_notes ?? "", /11:15 AM/);
  assert.ok(
    !fogo.deals.some((d) => d.items.some((i) => /Caipirinha/i.test(i.text))),
    "National Caipirinha Day is a one-off",
  );

  const bar = fogo.deals.find((d) => d.items.some((i) => i.text === "$6 Beers"));
  const bottles = fogo.deals.find((d) =>
    d.items.some((i) => i.text === "Half-Price South American bottles of wine under $130"),
  );
  assert.ok(bar && bottles, "expected Bar Fogo HH and half-price bottle rows");
  assert.deepEqual(bar.days, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(bar.start, null);
  assert.equal(bar.end, null);
  assert.equal(bar.time_window, "all day");
  assert.equal(bar.happy_hour, true);
  assert.deepEqual(
    bar.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$6 Beers", "$6"],
      ["$8 South American Wines", "$8"],
      ["$10 Brazilian-Inspired Cocktails", "$10"],
    ],
  );
  assert.deepEqual(bar.food_categories, ["drink"]);

  assert.deepEqual(bottles.days, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(bottles.start, null);
  assert.equal(bottles.end, null);
  assert.equal(bottles.time_window, "all day");
  assert.deepEqual(
    bottles.items.map((i) => [i.text, i.price ?? null]),
    [["Half-Price South American bottles of wine under $130", "50% off"]],
  );
  assert.deepEqual(bottles.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "fogo-de-chao"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "fogo-de-chao"));
});

test("The Food Market joins 2026-08-20 (Hampden, Mon–Fri 4–6 bar-only HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const market = byId["the-food-market"];
  assert.ok(market, "the-food-market missing");
  assert.deepEqual(venueShapeErrors(market), []);
  assert.equal(market.name, "The Food Market");
  assert.equal(market.neighborhood, "Hampden");
  assert.equal(
    market.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(market.status, "verified");
  assert.equal(market.address, "1017 W 36th St, Baltimore, MD 21211");
  assert.equal(market.phone, "(410) 366-0606");
  assert.equal(market.source_url, "https://www.the-food-market.com/happy-hour");
  assert.equal(market.source_type, "venue_website");
  assert.equal(market.last_verified, "2026-08-20");
  assert.equal(market.notes_public, "Happy hour is bar only, Monday–Friday 4–6pm.");
  assert.equal(market.lat, 39.3308684);
  assert.equal(market.lon, -76.6332423);
  assert.equal(market.deals.length, 1);
  assert.match(market.ops_notes ?? "", /Name=Hampden/);
  assert.match(market.ops_notes ?? "", /Already in \/hampden/);
  assert.match(market.ops_notes ?? "", /3pm/);
  assert.match(market.ops_notes ?? "", /AM happy hour|am happy hour/i);
  assert.match(market.ops_notes ?? "", /2\.75 a pop/);

  const hh = market.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "4pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Draft beer $5", "$5"],
      ["White marble wit $7", "$7"],
      ["Wine by the glass $6", "$6"],
      ["House bubbles $4", "$4"],
      ["Specialty cocktails $6", "$6"],
      ["Shot and a beer $6", "$6"],
      ["Edamame $4", "$4"],
      ["Cracker smack deluxe $7", "$7"],
      ["Truffle parmesan fries $5", "$5"],
      ["Amish soft pretzels $5", "$5"],
      ["Pan roasted mussels $12", "$12"],
      ["Buffalo pickles $6", "$6"],
      ["Garlicky shrimp torn bread $12", "$12"],
      ["Braised pork taco (2.75 a pop)", "$2.75"],
      ["Crab ball steam bun $8", "$8"],
      ["Crazy corn wings $10", "$10"],
      ["Pat LaFrieda burger $10", "$10"],
      ["1/2 cooked blondie $5", "$5"],
      ["Heathbar bread pudding $5", "$5"],
    ],
  );
  assert.deepEqual(hh.food_categories, [
    "drink",
    "small-plate/apps",
    "pretzel",
    "tacos",
    "wings",
    "burger",
    "seafood/crab",
  ]);
  assert.ok(!market.deals.some((d) => d.days.includes("sat") || d.days.includes("sun")));
  assert.ok(
    !hh.items.some((i) => i.price === "$3"),
    "do not invent the about-page $3 pretzel as a separate row",
  );
  assert.ok(!market.deals.some((d) => d.start === 180), "AM happy hour has no $ — not shipped");
  assert.ok(
    !market.deals.some((d) => d.start === 900 && d.end === 960),
    "do not invent a 3–4pm-only row",
  );

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "the-food-market"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "the-food-market"));
});

test("Gertrude's Restaurant joins 2026-08-20 (Johns Hopkins Homewood, Thursday prix-fixe, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const gert = byId.gertrudes;
  assert.ok(gert, "gertrudes missing");
  assert.deepEqual(venueShapeErrors(gert), []);
  assert.equal(gert.name, "Gertrude's Restaurant");
  assert.equal(gert.neighborhood, "Johns Hopkins Homewood");
  assert.equal(
    gert.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(gert.status, "verified");
  assert.equal(gert.address, "10 Art Museum Drive, Baltimore, MD 21218");
  assert.equal(gert.phone, "410-889-3399");
  assert.equal(gert.source_url, "https://www.gertrudesbaltimore.com/thursdays-with-gertie");
  assert.equal(gert.source_type, "venue_website");
  assert.equal(gert.last_verified, "2026-08-20");
  assert.equal(
    gert.notes_public,
    "Thursday $20 dinners. Boardwalk Crab Cake is a $5 upcharge. No discounts or substitutions.",
  );
  assert.equal(gert.lat, 39.3262199);
  assert.equal(gert.lon, -76.6190802);
  assert.equal(gert.deals.length, 2);
  assert.match(gert.ops_notes ?? "", /Name=Johns Hopkins Homewood/);
  assert.match(gert.ops_notes ?? "", /Do not invent a johns-hopkins-homewood view|Do not invent a \/johns-hopkins-homewood/);
  assert.match(gert.ops_notes ?? "", /Do not fold into \/hampden or \/inner-harbor/);
  assert.match(gert.ops_notes ?? "", /Wine Wednesday|Tuesdays with Gertie/);
  assert.match(gert.ops_notes ?? "", /Lite Fare/);
  assert.ok(
    !gert.deals.some((d) => d.time_window === "all day"),
    "do not invent all day",
  );

  const dinners = gert.deals.find((d) => d.items.some((i) => i.text === "$20 Dinners"));
  const three = gert.deals.find((d) => d.items.some((i) => i.text === "$36 3-Course Dinner"));
  assert.ok(dinners && three, "expected $20 dinners and $36 3-course rows");
  assert.deepEqual(dinners.days, ["thu"]);
  assert.equal(dinners.start, null);
  assert.equal(dinners.end, null);
  assert.equal(dinners.time_window, undefined);
  assert.deepEqual(
    dinners.items.map((i) => [i.text, i.price ?? null]),
    [["$20 Dinners", "$20"]],
  );
  assert.equal(dinners.food_categories, undefined, "prix-fixe spans the menu");

  assert.deepEqual(three.days, ["thu"]);
  assert.equal(three.start, null);
  assert.equal(three.end, null);
  assert.deepEqual(
    three.items.map((i) => [i.text, i.price ?? null]),
    [["$36 3-Course Dinner", "$36"]],
  );
  assert.equal(three.food_categories, undefined, "prix-fixe spans the menu");
  assert.ok(!gert.deals.some((d) => d.days.includes("wed") || d.days.includes("tue")));

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "gertrudes"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "gertrudes"),
    "Johns Hopkins Homewood must not fold into /hampden",
  );
  assert.ok(
    !venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "gertrudes"),
    "Johns Hopkins Homewood must not fold into /inner-harbor",
  );
  assert.equal(
    bySlug["johns-hopkins-homewood"],
    undefined,
    "do not invent a johns-hopkins-homewood view",
  );
});

test("Guilford Hall Brewery joins 2026-08-20 (Greenmount West, Wed wings + Fri burger, citywide)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const hall = byId["guilford-hall"];
  assert.ok(hall, "guilford-hall missing");
  assert.deepEqual(venueShapeErrors(hall), []);
  assert.equal(hall.name, "Guilford Hall Brewery");
  assert.equal(hall.neighborhood, "Greenmount West");
  assert.equal(
    hall.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(hall.status, "verified");
  assert.equal(hall.address, "1611 Guilford Ave, Baltimore, MD 21202");
  assert.equal(hall.phone, "(410) 305-9953");
  assert.equal(hall.source_url, "https://www.guilfordhall.com/happy-hour");
  assert.equal(hall.source_type, "venue_website");
  assert.equal(hall.last_verified, "2026-08-20");
  assert.equal(hall.notes_public, "Kitchen hours conclude 1 hour before close.");
  assert.equal(hall.lat, 39.3084005);
  assert.equal(hall.lon, -76.612048);
  assert.equal(hall.deals.length, 2);
  assert.match(hall.ops_notes ?? "", /Name=Greenmount West/);
  assert.match(hall.ops_notes ?? "", /Do not invent a greenmount-west view|Do not invent a \/greenmount-west/);
  assert.match(hall.ops_notes ?? "", /Do not fold into \/station-north/);
  assert.match(hall.ops_notes ?? "", /BURGUER/);
  assert.match(hall.ops_notes ?? "", /industry/i);
  assert.match(hall.ops_notes ?? "", /cashless/i);
  assert.ok(
    !hall.deals.some((d) => d.days.includes("tue")),
    "Tuesday industry night is gated — do not ship as a public row",
  );
  assert.ok(
    !hall.deals.some((d) => d.days.includes("thu") || d.days.includes("sun")),
    "Chef's Choice has no $",
  );
  const allText = hall.deals.flatMap((d) => d.items.map((i) => i.text)).join(" | ");
  assert.doesNotMatch(allText, /half-off pint|half off pint/i);

  const wed = hall.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const fri = hall.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.ok(wed && fri, "expected Wednesday wings and Friday burger rows");
  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, undefined);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["Wings & Beer $15", "$15"]],
  );
  assert.deepEqual(wed.food_categories, ["wings", "drink"]);

  assert.equal(fri.start, null);
  assert.equal(fri.end, null);
  assert.equal(fri.time_window, undefined);
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [["Burger & Brew $16", "$16"]],
  );
  assert.deepEqual(fri.food_categories, ["burger", "drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "guilford-hall"));
  assert.ok(
    !venuesInView(venues, bySlug["station-north"]).some((v) => v.id === "guilford-hall"),
    "Greenmount West must not fold into /station-north",
  );
  assert.equal(bySlug["greenmount-west"], undefined, "do not invent a greenmount-west view");
});

test("Hair of the Dog joins 2026-08-20 (South Baltimore / federal-hill, five weekday specials)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const hair = byId["hair-of-the-dog"];
  assert.ok(hair, "hair-of-the-dog missing");
  assert.deepEqual(venueShapeErrors(hair), []);
  assert.equal(hair.name, "Hair of the Dog");
  assert.equal(hair.neighborhood, "South Baltimore");
  assert.equal(
    hair.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(hair.status, "verified");
  assert.equal(hair.address, "1649 South Hanover Street, Baltimore, MD 21230");
  assert.equal(hair.phone, "410.814.0342");
  assert.equal(hair.source_url, "https://hairofthedogbaltimore.com/weekly-specials");
  assert.equal(hair.source_type, "venue_website");
  assert.equal(hair.last_verified, "2026-08-20");
  assert.equal(
    hair.notes_public,
    "Friday drink BOGO is 7–10pm. Thursday $6 burgers: extra toppings extra.",
  );
  assert.equal(hair.lat, 39.270571);
  assert.equal(hair.lon, -76.614979);
  assert.equal(hair.deals.length, 5);
  assert.match(hair.ops_notes ?? "", /Name=South Baltimore/);
  assert.match(hair.ops_notes ?? "", /Already in \/federal-hill/);
  assert.match(hair.ops_notes ?? "", /TUESDAYs/);
  assert.match(hair.ops_notes ?? "", /WEDNESDAYs/);
  assert.match(hair.ops_notes ?? "", /Ravens Games/);
  assert.match(hair.ops_notes ?? "", /Greg's Shitty Trivia|Greg’s Shitty Trivia/);
  assert.ok(
    !hair.deals.some((d) => d.days.includes("sat")),
    "pin no Saturday deal",
  );
  assert.ok(
    !hair.deals.some((d) => d.items.some((i) => /trivia/i.test(i.text))),
    "do not ship trivia as a food/drink row",
  );

  const mon = hair.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = hair.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = hair.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = hair.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const fri = hair.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.ok(mon && tue && wed && thu && fri, "expected one row per weekday");

  assert.equal(mon.start, null);
  assert.equal(mon.end, null);
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [["BOGO appetizers", "BOGO"]],
  );
  assert.deepEqual(mon.food_categories, ["small-plate/apps"]);

  assert.equal(tue.start, null);
  assert.equal(tue.end, null);
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Two chicken or ground beef tacos $6", "$6"],
      ["$6 select tequilas", "$6"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["tacos", "drink"]);

  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["$6 cheesesteaks", "$6"]],
  );
  assert.deepEqual(wed.food_categories, ["sandwich/cheesesteak"]);

  assert.equal(thu.start, null);
  assert.equal(thu.end, null);
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [["$6 Burgers", "$6"]],
  );
  assert.deepEqual(thu.food_categories, ["burger"]);

  assert.equal(fri.start, 1140);
  assert.equal(fri.end, 1320);
  assert.equal(fri.time_window, "7pm-10pm");
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [
      [
        "BOGO domestic drafts, domestic cans, Nutrl cans, Surfside cans, rail cocktails, and house wine",
        "BOGO",
      ],
    ],
  );
  assert.deepEqual(fri.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug["federal-hill"]).some((v) => v.id === "hair-of-the-dog"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "hair-of-the-dog"));
});

test("Hard Rock Cafe joins 2026-08-20 (Inner Harbor, Mon–Fri 3–6 HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const hrc = byId["hard-rock-cafe"];
  assert.ok(hrc, "hard-rock-cafe missing");
  assert.deepEqual(venueShapeErrors(hrc), []);
  assert.equal(hrc.name, "Hard Rock Cafe");
  assert.equal(hrc.neighborhood, "Inner Harbor");
  assert.equal(
    hrc.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(hrc.status, "verified");
  assert.equal(hrc.address, "601 E Pratt St, Baltimore, MD 21202");
  assert.equal(hrc.phone, "410-347-7625");
  assert.equal(hrc.source_url, "https://cafe.hardrock.com/baltimore/");
  assert.equal(hrc.source_type, "venue_website");
  assert.equal(hrc.last_verified, "2026-08-20");
  assert.equal(hrc.notes_public, undefined);
  assert.equal(hrc.lat, 39.2860594);
  assert.equal(hrc.lon, -76.6071214);
  assert.equal(hrc.deals.length, 1);
  assert.match(hrc.ops_notes ?? "", /Name=Inner Harbor/);
  assert.match(hrc.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(hrc.ops_notes ?? "", /11AM - 8PM/);
  assert.match(hrc.ops_notes ?? "", /do not copy it onto the deal clock/i);
  assert.match(hrc.ops_notes ?? "", /Orioles/);
  assert.match(hrc.ops_notes ?? "", /10 Apr 2025|2025-04-10/);
  assert.ok(
    !hrc.deals.some((d) => d.items.some((i) => /Orioles|holiday/i.test(i.text))),
    "Orioles 15% and holiday booking off",
  );

  const hh = hrc.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Nachos $8", "$8"],
      ["Jumbo Pretzel $8", "$8"],
      ["Tupelo Dippers $8", "$8"],
      ["Loaded Cheese Fries $8", "$8"],
      ["Chicken Sliders $10", "$10"],
      ["Wings $10", "$10"],
      ["Pepperoni Flatbread $10", "$10"],
      ["Domestic drafts $5", "$5"],
      ["Import/craft drafts $6", "$6"],
      ["Single liquor well drinks $6", "$6"],
      ["Select wines (6oz) $7", "$7"],
      ["Cocktails $7", "$7"],
    ],
  );
  assert.deepEqual(hh.food_categories, [
    "drink",
    "small-plate/apps",
    "pretzel",
    "sliders",
    "wings",
    "pizza",
  ]);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "hard-rock-cafe"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "hard-rock-cafe"));
});

test("Hersh's Pizza & Drinks joins 2026-08-20 (Riverside / locust-point, Wine Wednesday + times-only HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const hersh = byId.hershs;
  assert.ok(hersh, "hershs missing");
  assert.deepEqual(venueShapeErrors(hersh), []);
  assert.equal(hersh.name, "Hersh's Pizza & Drinks");
  assert.equal(hersh.neighborhood, "Riverside");
  assert.equal(
    hersh.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(hersh.status, "verified");
  assert.equal(hersh.address, "1843-45 Light Street, Baltimore MD 21230");
  assert.equal(hersh.phone, "443-438-4948");
  assert.equal(hersh.source_url, "https://hershs.com/events/");
  assert.equal(hersh.source_type, "venue_website");
  assert.equal(hersh.last_verified, "2026-08-20");
  assert.equal(hersh.notes_public, "Wine Wednesday half-off bottles is with dinner.");
  assert.equal(hersh.lat, 39.2686609);
  assert.equal(hersh.lon, -76.6116428);
  assert.equal(hersh.deals.length, 2);
  assert.match(hersh.ops_notes ?? "", /Name=Riverside/);
  assert.match(hersh.ops_notes ?? "", /Already in \/locust-point/);
  assert.match(hersh.ops_notes ?? "", /Do not fold into \/federal-hill/);
  assert.match(hersh.ops_notes ?? "", /Fried Chicken|Frickin/);
  assert.match(hersh.ops_notes ?? "", /Burger Thursdays/);
  assert.ok(
    !hersh.deals.some((d) => d.items.some((i) => /fried chicken|smash burger/i.test(i.text))),
    "Fried Chicken Tuesdays and Burger Thursdays have no $",
  );

  const wine = hersh.deals.find((d) => d.days.length === 1 && d.days[0] === "wed" && d.prices_published !== false);
  const hh = hersh.deals.find((d) => d.prices_published === false);
  assert.ok(wine && hh, "expected Wine Wednesday and times-only happy hour");

  assert.deepEqual(wine.days, ["wed"]);
  assert.equal(wine.start, null);
  assert.equal(wine.end, null);
  assert.equal(wine.time_window, undefined);
  assert.deepEqual(
    wine.items.map((i) => [i.text, i.price ?? null]),
    [["half-off bottles of wine with dinner", "50% off"]],
  );
  assert.deepEqual(wine.food_categories, ["drink"]);

  assert.deepEqual(hh.days, ["wed", "thu", "fri"]);
  assert.equal(hh.start, 1020);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "5pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.equal(hh.prices_published, false);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [["Happy Hour", null]],
  );
  assert.equal(hh.food_categories, undefined, "times-only — same class as The Point in Fells");

  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "hershs"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "hershs"));
  assert.ok(
    !venuesInView(venues, bySlug["federal-hill"]).some((v) => v.id === "hershs"),
    "Riverside must not fold into /federal-hill",
  );
});

test("HomeSlyce Mt. Vernon joins 2026-08-20 (Downtown / inner-harbor, HH + weekly pizza)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const mv = byId["homeslyce-mt-vernon"];
  assert.ok(mv, "homeslyce-mt-vernon missing");
  assert.deepEqual(venueShapeErrors(mv), []);
  assert.equal(mv.name, "HomeSlyce Mt. Vernon");
  assert.equal(mv.neighborhood, "Downtown");
  assert.equal(
    mv.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(mv.status, "verified");
  assert.equal(mv.address, "336 N Charles St, Baltimore, MD 21201");
  assert.equal(mv.phone, "(443) 501-4000");
  assert.equal(byId["homeslyce-canton"].phone, "(443) 501-4000", "do not 'fix' Canton phone");
  assert.equal(mv.source_url, "https://homeslyce.com/locations/mt-vernon/");
  assert.equal(mv.source_type, "venue_website");
  assert.equal(mv.last_verified, "2026-08-20");
  assert.equal(mv.notes_public, undefined);
  assert.equal(mv.lat, 39.2937348);
  assert.equal(mv.lon, -76.6156311);
  assert.equal(mv.deals.length, 5);
  assert.match(mv.ops_notes ?? "", /Name=Downtown/);
  assert.match(mv.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(mv.ops_notes ?? "", /Do not fold into \/mount-vernon/);
  assert.match(mv.ops_notes ?? "", /Do not invent a \/downtown/);
  assert.match(mv.ops_notes ?? "", /More details soon|Trivia Thursdays/);
  assert.ok(
    !mv.deals.some((d) => d.items.some((i) => /more details|trivia/i.test(i.text))),
    "Thursday/Friday 'more details soon' and trivia have no $",
  );

  const hh = mv.deals.find((d) => d.happy_hour === true);
  const mon = mv.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = mv.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = mv.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const sun = mv.deals.find((d) => d.days.length === 1 && d.days[0] === "sun");
  assert.ok(hh && mon && tue && wed && sun, "expected HH + Mon/Tue/Wed/Sun pizza rows");

  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 OFF Wings, Tenders & Chicken Quesadillas", "$3 off"],
      ["$5 Wines & Craft Beers", "$5"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "wings"]);

  assert.equal(mon.start, null);
  assert.equal(mon.end, null);
  assert.equal(mon.time_window, "all day");
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [['16" 2-topping pizza $19', "$19"]],
  );
  assert.deepEqual(mon.food_categories, ["pizza"]);

  assert.equal(tue.start, null);
  assert.equal(tue.end, null);
  assert.equal(tue.time_window, "all day");
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [["$1 toppings", "$1"]],
  );
  assert.deepEqual(tue.food_categories, ["pizza"]);

  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, "all day");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [['12" premium pizza $16', "$16"]],
  );
  assert.deepEqual(wed.food_categories, ["pizza"]);

  assert.equal(sun.start, null);
  assert.equal(sun.end, null);
  assert.equal(sun.time_window, "all day");
  assert.deepEqual(
    sun.items.map((i) => [i.text, i.price ?? null]),
    [
      ['12" Premium Pizza & 6 Wings $25', "$25"],
      ['16" Premium Pizza & 6 Wings $35', "$35"],
    ],
  );
  assert.deepEqual(sun.food_categories, ["pizza", "wings"]);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "homeslyce-mt-vernon"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "homeslyce-mt-vernon"));
  assert.ok(
    !venuesInView(venues, bySlug["mount-vernon"]).some((v) => v.id === "homeslyce-mt-vernon"),
    "Downtown must not fold into /mount-vernon",
  );
  assert.equal(bySlug.downtown, undefined, "do not invent a downtown view");
});

test("HomeSlyce JHU joins 2026-08-20 (Charles Village citywide, HH + pizza, no Monday pizza)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const jhu = byId["homeslyce-jhu"];
  assert.ok(jhu, "homeslyce-jhu missing");
  assert.deepEqual(venueShapeErrors(jhu), []);
  assert.equal(jhu.name, "HomeSlyce JHU");
  assert.equal(jhu.neighborhood, "Charles Village");
  assert.equal(
    jhu.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-20",
  );
  assert.equal(jhu.status, "verified");
  assert.equal(jhu.address, "3333 N Charles St, Baltimore, MD 21218");
  assert.equal(jhu.phone, "(443) 315-4046");
  assert.equal(jhu.source_url, "https://homeslyce.com/locations/jhu-charles-village/");
  assert.equal(jhu.source_type, "venue_website");
  assert.equal(jhu.last_verified, "2026-08-20");
  assert.equal(jhu.notes_public, undefined);
  assert.equal(jhu.lat, 39.3286352);
  assert.equal(jhu.lon, -76.6171728);
  assert.equal(jhu.deals.length, 4);
  assert.match(jhu.ops_notes ?? "", /Name=Charles Village/);
  assert.match(jhu.ops_notes ?? "", /Do not invent a \/charles-village|already in citywideOnly/i);
  assert.match(jhu.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(jhu.ops_notes ?? "", /Mondays CLOSED/);
  assert.match(jhu.ops_notes ?? "", /12\.00 AM/);
  assert.match(jhu.ops_notes ?? "", /JSON-LD/);
  assert.match(jhu.ops_notes ?? "", /do not drop `?mon`?|Ship Monday on the HH/i);
  assert.ok(
    !jhu.deals.some((d) => d.days.length === 1 && d.days[0] === "mon"),
    "do not ship Monday pizza — door page says Mondays CLOSED",
  );
  assert.ok(
    !jhu.deals.some((d) => d.items.some((i) => /trivia/i.test(i.text))),
    "Trivia Tuesdays have no $",
  );

  const hh = jhu.deals.find((d) => d.happy_hour === true);
  const tue = jhu.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = jhu.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const sun = jhu.deals.find((d) => d.days.length === 1 && d.days[0] === "sun");
  assert.ok(hh && tue && wed && sun, "expected HH + Tue/Wed/Sun rows");
  assert.ok(hh.days.includes("mon"), "ship Monday on the HH row as quoted");
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 OFF Wings, Tenders & Chicken Quesadillas", "$3 off"],
      ["$5 Wines & Craft Beers", "$5"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "wings"]);

  assert.equal(tue.start, null);
  assert.equal(tue.end, null);
  assert.equal(tue.time_window, "all day");
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [["$1 toppings", "$1"]],
  );
  assert.deepEqual(tue.food_categories, ["pizza"]);

  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, "all day");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [['12" premium pizza $16', "$16"]],
  );
  assert.deepEqual(wed.food_categories, ["pizza"]);

  assert.equal(sun.start, null);
  assert.equal(sun.end, null);
  assert.equal(sun.time_window, "all day");
  assert.deepEqual(
    sun.items.map((i) => [i.text, i.price ?? null]),
    [
      ['12" Premium Pizza & 6 Wings $25', "$25"],
      ['16" Premium Pizza & 6 Wings $35', "$35"],
    ],
  );
  assert.deepEqual(sun.food_categories, ["pizza", "wings"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "homeslyce-jhu"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "homeslyce-jhu"),
    "Charles Village must not fold into /hampden",
  );
  assert.equal(bySlug["charles-village"], undefined, "do not invent a charles-village view");
});

test("iBar joins 2026-08-21 (Charles North / station-north, Tue/Thu/Fri priced; college-ID off)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const ibar = byId.ibar;
  assert.ok(ibar, "ibar missing");
  assert.deepEqual(venueShapeErrors(ibar), []);
  assert.equal(ibar.name, "iBar");
  assert.equal(ibar.neighborhood, "Charles North");
  assert.equal(
    ibar.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(ibar.status, "verified");
  assert.equal(ibar.address, "2118 Maryland Avenue, Baltimore, MD 21218");
  assert.equal(ibar.phone, "443-759-6147");
  assert.equal(ibar.source_url, "https://www.ibarbaltimore.com/charles-village-happy-hour/");
  assert.equal(ibar.source_type, "venue_website");
  assert.equal(ibar.last_verified, "2026-08-21");
  assert.equal(ibar.notes_public, "Friday is listed as Ladies' Night.");
  assert.equal(ibar.lat, 39.313752);
  assert.equal(ibar.lon, -76.618429);
  assert.equal(ibar.deals.length, 3);
  assert.match(ibar.ops_notes ?? "", /Name=Charles North/);
  assert.match(ibar.ops_notes ?? "", /Already in \/station-north/);
  assert.match(ibar.ops_notes ?? "", /City Name wins/);
  assert.match(ibar.ops_notes ?? "", /Heinekins/);
  assert.match(ibar.ops_notes ?? "", /Sunday Football Season/);
  assert.match(ibar.ops_notes ?? "", /Sunday: 5:00pm/);
  assert.match(ibar.ops_notes ?? "", /College ID/);
  assert.ok(
    !ibar.deals.some((d) => d.days.includes("wed") || d.days.includes("sat")),
    "college-ID gated Wednesday Wingsday and Saturday College Night stay off",
  );

  const tue = ibar.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const thu = ibar.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const fri = ibar.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.ok(tue && thu && fri, "expected Tue / Thu / Fri rows");

  assert.equal(tue.start, null);
  assert.equal(tue.end, null);
  assert.equal(tue.time_window, undefined);
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["2 Amstel or Heineken $5", "$5"],
      ["2 rail mixed drinks $6", "$6"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["drink"]);

  assert.equal(thu.start, 1200);
  assert.equal(thu.end, 1320);
  assert.equal(thu.time_window, "8pm-10pm");
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 burgers", "$5"],
      ["$2.50 Yuengling pints", "$2.50"],
    ],
  );
  assert.deepEqual(thu.food_categories, ["burger", "drink"]);

  assert.equal(fri.start, null);
  assert.equal(fri.end, 1440);
  assert.equal(fri.time_window, "until midnight");
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 Cosmos", "$5"],
      ["1/2 price salads", "50% off"],
    ],
  );
  assert.deepEqual(fri.food_categories, ["drink", "small-plate/apps"]);

  assert.ok(venuesInView(venues, bySlug["station-north"]).some((v) => v.id === "ibar"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "ibar"));
});

test("Indigma joins 2026-08-21 (Mid-Town Belvedere / mount-vernon, Sat–Sun thaali)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const indigma = byId.indigma;
  assert.ok(indigma, "indigma missing");
  assert.deepEqual(venueShapeErrors(indigma), []);
  assert.equal(indigma.name, "Indigma");
  assert.equal(indigma.neighborhood, "Mid-Town Belvedere");
  assert.equal(
    indigma.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(indigma.status, "verified");
  assert.equal(indigma.address, "900 Cathedral Street, Baltimore, Maryland 21201");
  assert.equal(indigma.phone, "(443) 449-6483");
  assert.equal(indigma.source_url, "https://www.indigmabistro.com/");
  assert.equal(indigma.source_type, "venue_website");
  assert.equal(indigma.last_verified, "2026-08-21");
  assert.equal(indigma.notes_public, undefined);
  assert.equal(indigma.lat, 39.2997892);
  assert.equal(indigma.lon, -76.6174262);
  assert.equal(indigma.deals.length, 1);
  assert.match(indigma.ops_notes ?? "", /Name=Mid-Town Belvedere/);
  assert.match(indigma.ops_notes ?? "", /Already in \/mount-vernon/);
  assert.match(indigma.ops_notes ?? "", /Mon: Closed/);
  assert.match(indigma.ops_notes ?? "", /do not copy onto the deal clock/i);
  assert.match(indigma.ops_notes ?? "", /Martini/);
  assert.match(indigma.ops_notes ?? "", /Restaurant Week/);
  assert.ok(
    !indigma.deals.some((d) => d.items.some((i) => /martini|wine/i.test(i.text))),
    "martini and wine specials have no $",
  );

  const thaali = indigma.deals[0];
  assert.deepEqual(thaali.days, ["sat", "sun"]);
  assert.equal(thaali.start, null);
  assert.equal(thaali.end, null);
  assert.equal(thaali.time_window, undefined);
  assert.deepEqual(
    thaali.items.map((i) => [i.text, i.price ?? null]),
    [["Thaali $16.95", "$16.95"]],
  );
  assert.equal(thaali.food_categories, undefined, "prix-fixe assortment — same class as Gertrude's Thursday");
  assert.ok(!indigma.deals.some((d) => d.time_window === "all day" || /brunch/i.test(d.items[0].text)));

  assert.ok(venuesInView(venues, bySlug["mount-vernon"]).some((v) => v.id === "indigma"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "indigma"));
});

test("Johnny Rad's joins 2026-08-21 (Upper Fells Point citywide, HH + Monday pies + late BOGO)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const jr = byId["johnny-rads"];
  assert.ok(jr, "johnny-rads missing");
  assert.deepEqual(venueShapeErrors(jr), []);
  assert.equal(jr.name, "Johnny Rad's Pizzeria Tavern");
  assert.equal(jr.neighborhood, "Upper Fells Point");
  assert.equal(
    jr.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(jr.status, "verified");
  assert.equal(jr.address, "2108 Eastern Avenue, Baltimore, Maryland 21231");
  assert.equal(jr.phone, "443-759-6464");
  assert.equal(jr.source_url, "https://johnnyrads.com/daily-stuff");
  assert.equal(jr.source_type, "venue_website");
  assert.equal(jr.last_verified, "2026-08-21");
  assert.equal(
    jr.notes_public,
    "Monday $14 large pies are dine-in only, with a drink. Friday–Saturday late-night BOGO cans/bottles is dine-in only.",
  );
  assert.equal(jr.lat, 39.2859477);
  assert.equal(jr.lon, -76.5866822);
  assert.equal(jr.deals.length, 4);
  assert.match(jr.ops_notes ?? "", /Name=Upper Fells Point/);
  assert.match(jr.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(jr.ops_notes ?? "", /Do not invent a \/upper-fells-point/);
  assert.match(jr.ops_notes ?? "", /Do not fold into \/fells-point/);
  assert.match(jr.ops_notes ?? "", /couple fo/);
  assert.ok(
    !jr.deals.some((d) => d.items.some((i) => /couple fo/i.test(i.text))),
    "do not invent the truncated late-night food line",
  );

  const weekdayHh = jr.deals.find(
    (d) => d.happy_hour === true && d.days.length === 4 && d.days[0] === "mon",
  );
  const friHh = jr.deals.find((d) => d.happy_hour === true && d.days.length === 1 && d.days[0] === "fri");
  const pies = jr.deals.find((d) => d.days.length === 1 && d.days[0] === "mon" && d.happy_hour !== true);
  const late = jr.deals.find((d) => d.days.length === 2 && d.days.includes("fri") && d.days.includes("sat"));
  assert.ok(weekdayHh && friHh && pies && late, "expected weekday HH, Friday HH, Monday pies, late BOGO");

  assert.deepEqual(weekdayHh.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(weekdayHh.start, 960);
  assert.equal(weekdayHh.end, 1140);
  assert.equal(weekdayHh.time_window, "4pm-7pm");
  assert.deepEqual(
    weekdayHh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$1.50 off all draft beers", "$1.50 off"],
      ["$5 glasses of wine", "$5"],
      ["$4 rail drinks", "$4"],
    ],
  );
  assert.deepEqual(weekdayHh.food_categories, ["drink"]);

  assert.deepEqual(friHh.days, ["fri"]);
  assert.equal(friHh.start, 720);
  assert.equal(friHh.end, 1140);
  assert.equal(friHh.time_window, "12pm-7pm");
  assert.deepEqual(
    friHh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$1.50 off all draft beers", "$1.50 off"],
      ["$5 glasses of wine", "$5"],
      ["$4 rail drinks", "$4"],
    ],
  );
  assert.deepEqual(friHh.food_categories, ["drink"]);

  assert.equal(pies.start, 960);
  assert.equal(pies.end, 1320);
  assert.equal(pies.time_window, "4pm-10pm");
  assert.deepEqual(
    pies.items.map((i) => [i.text, i.price ?? null]),
    [['$14 large 16" pies with drink purchase', "$14"]],
  );
  assert.deepEqual(pies.food_categories, ["pizza"]);

  assert.equal(late.start, 1320);
  assert.equal(late.end, 1440);
  assert.equal(late.time_window, "10pm-12am");
  assert.deepEqual(
    late.items.map((i) => [i.text, i.price ?? null]),
    [["BOGO select cans & bottles", "BOGO"]],
  );
  assert.deepEqual(late.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "johnny-rads"));
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "johnny-rads"),
    "Upper Fells Point must not fold into /fells-point",
  );
  assert.equal(bySlug["upper-fells-point"], undefined, "do not invent an upper-fells-point view");
});

test("Kechy Pizza Co joins 2026-08-21 (Downtown / inner-harbor, daily G.O.A.T. HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const kechy = byId["kechy-pizza"];
  assert.ok(kechy, "kechy-pizza missing");
  assert.deepEqual(venueShapeErrors(kechy), []);
  assert.equal(kechy.name, "Kechy Pizza Co");
  assert.equal(kechy.neighborhood, "Downtown");
  assert.equal(
    kechy.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(kechy.status, "verified");
  assert.equal(kechy.address, "207 E Redwood St, Baltimore, MD 21202");
  assert.equal(kechy.phone, "(443) 977-4244");
  assert.equal(kechy.source_url, "https://www.kechypizza.com/baltimore");
  assert.equal(kechy.source_type, "venue_website");
  assert.equal(kechy.last_verified, "2026-08-21");
  assert.equal(kechy.notes_public, undefined);
  assert.equal(kechy.lat, 39.2888132);
  assert.equal(kechy.lon, -76.6144056);
  assert.equal(kechy.deals.length, 1);
  assert.match(kechy.ops_notes ?? "", /Name=Downtown/);
  assert.match(kechy.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(kechy.ops_notes ?? "", /Do not invent a \/downtown/);
  assert.match(kechy.ops_notes ?? "", /Westminster/);
  assert.match(kechy.ops_notes ?? "", /G\.O\.A\.T/);
  assert.match(kechy.ops_notes ?? "", /sangria/);

  const hh = kechy.deals[0];
  assert.deepEqual(hh.days, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "4pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$5 starters", "$5"],
      ["$6 cocktails", "$6"],
      ["$2 Natty Boh draft", "$2"],
      ["red sangria on tap", null],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);
  assert.ok(!hh.items.some((i) => i.text.toLowerCase().includes("sangria") && i.price), "do not invent a sangria $");

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "kechy-pizza"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "kechy-pizza"));
  assert.equal(bySlug.downtown, undefined, "do not invent a downtown view");
});

test("B&O American Brasserie joins 2026-08-21 (Downtown / inner-harbor, weekday HH only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bo = byId["bo-american-brasserie"];
  assert.ok(bo, "bo-american-brasserie missing");
  assert.deepEqual(venueShapeErrors(bo), []);
  assert.equal(bo.name, "B&O American Brasserie");
  assert.equal(bo.neighborhood, "Downtown");
  assert.equal(
    bo.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(bo.status, "verified");
  assert.equal(bo.address, "2 North Charles Street, Baltimore, Maryland, 21201");
  assert.equal(bo.phone, "443-692-6172");
  assert.equal(bo.source_url, "https://bandorestaurant.com/events");
  assert.equal(bo.source_type, "venue_website");
  assert.equal(bo.last_verified, "2026-08-21");
  assert.equal(bo.notes_public, undefined);
  assert.equal(bo.lat, 39.2897899);
  assert.equal(bo.lon, -76.6155584);
  assert.equal(bo.deals.length, 1);
  assert.match(bo.ops_notes ?? "", /Name=Downtown/);
  assert.match(bo.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(bo.ops_notes ?? "", /Morely/);
  assert.match(bo.ops_notes ?? "", /4:30 p\.m\.- 6:30 p\.m\./);
  assert.match(bo.ops_notes ?? "", /Happy Hour Daily 4pm - 6pm|Daily 4pm - 6pm/);
  assert.match(bo.ops_notes ?? "", /Power Lunch/);
  assert.match(bo.ops_notes ?? "", /Neighbor/);
  assert.match(bo.ops_notes ?? "", /Magnum/);
  assert.ok(
    !bo.deals.some((d) => d.start === 960 && d.end === 1080),
    "do not ship the times-only Daily 4pm-6pm footer clock",
  );
  assert.ok(
    !bo.deals.some((d) => d.items.some((i) => /power lunch|mimosa|10%/i.test(i.text))),
    "Power Lunch, magnum mimosas, and neighbor-gated 10% stay off",
  );

  const hh = bo.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 990);
  assert.equal(hh.end, 1110);
  assert.equal(hh.time_window, "4:30pm-6:30pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 select beer", "$3"],
      ["$4 sparkling and house wines", "$4"],
      ["$5 cocktail of the day", "$5"],
      ["bar snacks and flatbreads", null],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "bo-american-brasserie"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "bo-american-brasserie"));
});

test("La Calle joins 2026-08-21 (Fells Point, daily 4–6 HH, named eats and drinks)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const calle = byId["la-calle"];
  assert.ok(calle, "la-calle missing");
  assert.deepEqual(venueShapeErrors(calle), []);
  assert.equal(calle.name, "La Calle");
  assert.equal(calle.neighborhood, "Fells Point");
  assert.equal(
    calle.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(calle.status, "verified");
  assert.equal(calle.address, "623 S Broadway Baltimore MD 21231");
  assert.equal(calle.phone, "+1 (443) 835-2215");
  assert.equal(calle.source_url, "https://www.lacallerestaurant.com/contact-2/");
  assert.equal(calle.source_type, "venue_website");
  assert.equal(calle.last_verified, "2026-08-21");
  assert.equal(calle.notes_public, undefined);
  assert.equal(calle.lat, 39.2842935);
  assert.equal(calle.lon, -76.5931531);
  assert.equal(calle.deals.length, 1);
  assert.match(calle.ops_notes ?? "", /Name=Fells Point/);
  assert.match(calle.ops_notes ?? "", /Already in \/fells-point/);
  assert.match(calle.ops_notes ?? "", /12:00 pm/);
  assert.match(calle.ops_notes ?? "", /do not “correct” it to midnight|do not "correct" it to midnight/i);
  assert.match(calle.ops_notes ?? "", /happyhour-022026\.pdf/);
  assert.match(calle.ops_notes ?? "", /Pellizcadas/);
  assert.match(calle.ops_notes ?? "", /White claw tequila/);
  assert.match(calle.ops_notes ?? "", /DESSERTS/);
  assert.match(calle.ops_notes ?? "", /COFFE/);
  assert.match(calle.ops_notes ?? "", /Desserts-HH_compressed/);
  assert.ok(
    !calle.deals.some((d) =>
      d.items.some((i) => /tres leches|churros|flan|ice cream|coffee/i.test(i.text)),
    ),
    "DESSERTS / COFFE page and Desserts-HH PDF stay off this row",
  );

  const hh = calle.deals[0];
  assert.deepEqual(hh.days, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "4pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Flautas de Pollo $7", "$7"],
      ["Empanadas Favoritas $7", "$7"],
      ["Pellizcadas de Pollo $7", "$7"],
      ["Bruselas Tacos $7", "$7"],
      ["Bar Nachitos $7", "$7"],
      ["Tacos de Pollo $7", "$7"],
      ["Tacos al Pastor $7", "$7"],
      ["Margarita Clasica $8", "$8"],
      ["Paloma $8", "$8"],
      ["Sangria Blanco $8", "$8"],
      ["Vino Rojo $7", "$7"],
      ["Vino blanco $7", "$7"],
      ["White claw tequila $6", "$6"],
      ["Tecate $4", "$4"],
      ["Tequila 1 oz Corralejo blanco $8", "$8"],
      ["Mezcal 1 oz Fidencio espadin $8", "$8"],
      ["Raicilla 1 oz La venenosa tavernas $8", "$8"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["tacos", "small-plate/apps", "drink"]);

  assert.ok(venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "la-calle"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "la-calle"));
});

test("La Cuchara joins 2026-08-21 (Jones Falls Area citywide, weekday bar HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const cuchara = byId["la-cuchara"];
  assert.ok(cuchara, "la-cuchara missing");
  assert.deepEqual(venueShapeErrors(cuchara), []);
  assert.equal(cuchara.name, "La Cuchara");
  assert.equal(cuchara.neighborhood, "Jones Falls Area");
  assert.equal(
    cuchara.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(cuchara.status, "verified");
  assert.equal(cuchara.address, "3600 Clipper Mill Rd. | Baltimore Md. 21211");
  assert.equal(cuchara.phone, "(443) 708-3838");
  assert.equal(cuchara.source_url, "https://www.lacucharabaltimore.com/menu");
  assert.equal(cuchara.source_type, "venue_website");
  assert.equal(cuchara.last_verified, "2026-08-21");
  assert.equal(cuchara.notes_public, "Bar happy hour.");
  assert.equal(cuchara.lat, 39.3308911);
  assert.equal(cuchara.lon, -76.6424639);
  assert.equal(cuchara.deals.length, 1);
  assert.match(cuchara.ops_notes ?? "", /Name=Jones Falls Area/);
  assert.match(cuchara.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(cuchara.ops_notes ?? "", /Do not invent a \/jones-falls-area/);
  assert.match(cuchara.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(cuchara.ops_notes ?? "", /Sunday through Thursday 5 pm - 9 pm/);
  assert.match(cuchara.ops_notes ?? "", /Friday and Saturday 5 pm - 10 pm/);
  assert.match(cuchara.ops_notes ?? "", /Fouders Oktoberfest/);
  assert.match(cuchara.ops_notes ?? "", /do not copy onto the deal clock/i);
  assert.match(cuchara.ops_notes ?? "", /Do not invent pintxos names/);

  const hh = cuchara.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 1020);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "5pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["half price pintxos and raciones", "50% off"],
      ["$6 gin & tonic du jour", "$6"],
      ["$6 beer & seltzer", "$6"],
      ["wine glass $6", "$6"],
      ["wine bottle $22", "$22"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);
  assert.ok(
    !hh.items.some((i) => /gilda|jamon|tortilla|croqueta/i.test(i.text)),
    "do not invent pintxos names from the regular menu PDFs",
  );

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "la-cuchara"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "la-cuchara"),
    "Jones Falls Area must not fold into /hampden",
  );
  assert.equal(bySlug["jones-falls-area"], undefined, "do not invent a jones-falls-area view");
});

test("Sally O's joins 2026-08-21 (Highlandtown citywide, Wednesday wine only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const sally = byId["sally-os"];
  assert.ok(sally, "sally-os missing");
  assert.deepEqual(venueShapeErrors(sally), []);
  assert.equal(sally.name, "Sally O's");
  assert.equal(sally.neighborhood, "Highlandtown");
  assert.equal(
    sally.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(sally.status, "verified");
  assert.equal(sally.address, "3531 Gough Street, Baltimore, MD 21224");
  assert.equal(sally.phone, "410-624-5631");
  assert.equal(sally.source_url, "https://sallyos.com/");
  assert.equal(sally.source_type, "venue_website");
  assert.equal(sally.last_verified, "2026-08-21");
  assert.equal(sally.notes_public, undefined);
  assert.equal(sally.lat, 39.2883975);
  assert.equal(sally.lon, -76.5674018);
  assert.equal(sally.deals.length, 1);
  assert.match(sally.ops_notes ?? "", /Name=Highlandtown/);
  assert.match(sally.ops_notes ?? "", /citywideOnly/);
  assert.match(sally.ops_notes ?? "", /Do not invent a \/highlandtown/);
  assert.match(sally.ops_notes ?? "", /Do not fold into \/canton/);
  assert.match(sally.ops_notes ?? "", /Natty Wine Cult/);
  assert.match(sally.ops_notes ?? "", /Taco Tuesday/);
  assert.match(sally.ops_notes ?? "", /prices_published: false/);
  assert.ok(
    !sally.deals.some((d) => d.prices_published === false || d.time_window === "5pm-7pm"),
    "Mon–Thu 5–7 times-only HH stays off",
  );
  assert.ok(
    !sally.deals.some((d) => d.items.some((i) => /taco/i.test(i.text))),
    "Taco Tuesday stays off (named, no $)",
  );

  const wine = sally.deals[0];
  assert.deepEqual(wine.days, ["wed"]);
  assert.equal(wine.start, null);
  assert.equal(wine.end, null);
  assert.equal(wine.time_window, undefined);
  assert.deepEqual(
    wine.items.map((i) => [i.text, i.price ?? null]),
    [["50% off all bottles of wine", "50% off"]],
  );
  assert.deepEqual(wine.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "sally-os"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "sally-os"),
    "Highlandtown must not fold into /canton",
  );
  assert.equal(bySlug.highlandtown, undefined, "do not invent a highlandtown view");
});

test("Shotti's Point Charm City joins 2026-08-21 (Riverside / locust-point, weeknight specials)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const shotti = byId["shottis-point"];
  assert.ok(shotti, "shottis-point missing");
  assert.deepEqual(venueShapeErrors(shotti), []);
  assert.equal(shotti.name, "Shotti's Point Charm City");
  assert.equal(shotti.neighborhood, "Riverside");
  assert.equal(
    shotti.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(shotti.status, "verified");
  assert.equal(shotti.address, "701 E Fort Ave, Baltimore, MD 21230");
  assert.equal(shotti.phone, "443-835-2968");
  assert.equal(shotti.source_url, "https://shottispointcharmcity.com/specials");
  assert.equal(shotti.source_type, "venue_website");
  assert.equal(shotti.last_verified, "2026-08-21");
  assert.equal(shotti.notes_public, undefined);
  assert.equal(shotti.lat, 39.2723858);
  assert.equal(shotti.lon, -76.6040458);
  assert.equal(shotti.deals.length, 4);
  assert.match(shotti.ops_notes ?? "", /Name=Riverside/);
  assert.match(shotti.ops_notes ?? "", /Already in \/locust-point/);
  assert.match(shotti.ops_notes ?? "", /11:30 am to 2:00 am/);
  assert.match(shotti.ops_notes ?? "", /do not copy onto a deal clock/i);
  assert.match(shotti.ops_notes ?? "", /hh\.jpeg/);
  assert.match(shotti.ops_notes ?? "", /1643765265207/);
  assert.match(shotti.ops_notes ?? "", /\/happy-hour 404/);
  assert.ok(
    !shotti.deals.some((d) => d.time_window === "all day" || d.time_window === "2pm-6pm"),
    "no all-day clock; stale 2pm-6pm HH graphic stays off",
  );
  assert.ok(
    shotti.deals.every((d) => d.start === null && d.end === null && d.time_window === undefined),
    "weeknight block has no clock",
  );

  const mon = shotti.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = shotti.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = shotti.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = shotti.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  assert.ok(mon && tue && wed && thu, "expected Mon / Tue / Wed / Thu rows");

  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$15 bottles of house wines", "$15"],
      ["$3 off all pizzas", "$3 off"],
    ],
  );
  assert.deepEqual(mon.food_categories, ["pizza", "drink"]);
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$15 domestic buckets", "$15"],
      ["$6 craft beers", "$6"],
      ["$10 build ya own burger", "$10"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["burger", "drink"]);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$2 off wings", "$2 off"],
      ["$7 select bourbons", "$7"],
      ["$8 Old Fashioned", "$8"],
    ],
  );
  assert.deepEqual(wed.food_categories, ["wings", "drink"]);
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 off tacos", "$3 off"],
      ["$8 Margarita", "$8"],
      ["$7 sangrias", "$7"],
      ["$4 South of the Border beers", "$4"],
    ],
  );
  assert.deepEqual(thu.food_categories, ["tacos", "drink"]);

  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "shottis-point"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "shottis-point"));
});

test("Silver Queen Cafe joins 2026-08-21 (Waltherson citywide, Wed/Thu priced)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const sq = byId["silver-queen-cafe"];
  assert.ok(sq, "silver-queen-cafe missing");
  assert.deepEqual(venueShapeErrors(sq), []);
  assert.equal(sq.name, "Silver Queen Cafe");
  assert.equal(sq.neighborhood, "Waltherson");
  assert.equal(
    sq.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(sq.status, "verified");
  assert.equal(sq.address, "5429 Harford Road, Baltimore, MD 21214");
  assert.equal(sq.phone, "443-345-2020");
  assert.equal(sq.source_url, "https://www.silverqueencafe.com/");
  assert.equal(sq.source_type, "venue_website");
  assert.equal(sq.last_verified, "2026-08-21");
  assert.equal(sq.notes_public, undefined);
  assert.equal(sq.lat, 39.3517932);
  assert.equal(sq.lon, -76.5617112);
  assert.equal(sq.deals.length, 2);
  assert.match(sq.ops_notes ?? "", /Name=Waltherson/);
  assert.match(sq.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(sq.ops_notes ?? "", /Do not invent a \/waltherson/);
  assert.match(sq.ops_notes ?? "", /Wednesday & Thursday Dinner: 5pm–9pm/);
  assert.match(sq.ops_notes ?? "", /Get a Burger is/);
  assert.match(sq.ops_notes ?? "", /do not invent a burger price/i);
  assert.match(sq.ops_notes ?? "", /this week, it's happy hour at the bar all night long!/);
  assert.match(sq.ops_notes ?? "", /Market at Hamilton/);
  assert.match(sq.ops_notes ?? "", /Booze & BBQ/);
  assert.ok(
    !sq.deals.some((d) => d.items.some((i) => /burger/i.test(i.text))),
    "do not invent a burger price from Get a Burger is",
  );
  assert.ok(
    !sq.deals.some((d) => /this week/i.test(d.proof_quote ?? "") || d.items.some((i) => /all night/i.test(i.text))),
    "this-week bar HH stays off",
  );

  const wed = sq.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = sq.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  assert.ok(wed && thu, "expected Wed / Thu rows");
  assert.equal(wed.start, null);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, undefined);
  assert.equal(thu.start, null);
  assert.equal(thu.end, null);
  assert.equal(thu.time_window, undefined);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["20% off all bottles of wine", "20% off"],
      ["sangria $10 per glass", "$10"],
    ],
  );
  assert.deepEqual(wed.food_categories, ["drink"]);
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Whiskeys are $2 off", "$2 off"],
      ["first beer is on the house", "free"],
      ["all cans of beer are only $4", "$4"],
    ],
  );
  assert.deepEqual(thu.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "silver-queen-cafe"));
  assert.equal(bySlug.waltherson, undefined, "do not invent a waltherson view");
});

test("The Empanada Lady joins 2026-08-21 (Downtown / inner-harbor, weekday 4–8 + Sat 6–8)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const emp = byId["the-empanada-lady"];
  assert.ok(emp, "the-empanada-lady missing");
  assert.deepEqual(venueShapeErrors(emp), []);
  assert.equal(emp.name, "The Empanada Lady");
  assert.equal(emp.neighborhood, "Downtown");
  assert.equal(
    emp.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(emp.status, "verified");
  assert.equal(emp.address, "10 S Street STE 100, Baltimore, MD 21202");
  assert.equal(emp.phone, "(443) 377-1133");
  assert.equal(emp.source_url, "https://www.theempanadalady.shop/happyhour");
  assert.equal(emp.source_type, "venue_website");
  assert.equal(emp.last_verified, "2026-08-21");
  assert.equal(emp.notes_public, "We add a 15% love (gratuity) to all experiences.");
  assert.equal(emp.lat, 39.2892322);
  assert.equal(emp.lon, -76.6112179);
  assert.equal(emp.deals.length, 2);
  assert.match(emp.ops_notes ?? "", /Name=Downtown/);
  assert.match(emp.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(emp.ops_notes ?? "", /Do not invent a \/downtown/);
  assert.match(emp.ops_notes ?? "", /omit Mon\/Tue/);
  assert.match(emp.ops_notes ?? "", /Do not invent closed/);
  assert.match(emp.ops_notes ?? "", /Do not drop Mon\/Tue from the graphic/);
  assert.match(emp.ops_notes ?? "", /HENNESSEY/);
  assert.match(emp.ops_notes ?? "", /PAPAS/);

  const items = [
    ["cocktails $8.99", "$8.99"],
    ["shooters $7.99", "$7.99"],
    ["well shots $6.99", "$6.99"],
    ["$5 beer", "$5"],
    ["$7 wine", "$7"],
    ["$10 Don Julio Blanco", "$10"],
    ["$10 HENNESSEY", "$10"],
    ["(6) wings $10.99", "$10.99"],
    ["nachos $10.99", "$10.99"],
    ["salmon bites $10.99", "$10.99"],
    ["sides $5.99", "$5.99"],
    ["PAPAS $5.99", "$5.99"],
    ["quesadillas $10.99", "$10.99"],
  ];
  const weekday = emp.deals.find((d) => d.days.length === 5 && d.days[0] === "mon");
  const sat = emp.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.ok(weekday && sat, "expected weekday + Saturday rows");
  assert.deepEqual(weekday.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(weekday.start, 960);
  assert.equal(weekday.end, 1200);
  assert.equal(weekday.time_window, "4pm-8pm");
  assert.equal(weekday.happy_hour, true);
  assert.deepEqual(weekday.items.map((i) => [i.text, i.price ?? null]), items);
  assert.deepEqual(weekday.food_categories, ["drink", "wings", "small-plate/apps"]);
  assert.equal(sat.start, 1080);
  assert.equal(sat.end, 1200);
  assert.equal(sat.time_window, "6pm-8pm");
  assert.equal(sat.happy_hour, true);
  assert.deepEqual(sat.items.map((i) => [i.text, i.price ?? null]), items);
  assert.deepEqual(sat.food_categories, ["drink", "wings", "small-plate/apps"]);
  assert.ok(
    emp.deals.every((d) => d.end === 1200),
    "stated close is 8pm (1200), not a copied 7pm 1140",
  );

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "the-empanada-lady"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "the-empanada-lady"));
});

test("True Chesapeake Oyster Co. joins 2026-08-21 (Jones Falls Area citywide, Tue–Sun 5–7 + Wed wine)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const tc = byId["true-chesapeake"];
  assert.ok(tc, "true-chesapeake missing");
  assert.deepEqual(venueShapeErrors(tc), []);
  assert.equal(tc.name, "True Chesapeake Oyster Co.");
  assert.equal(tc.neighborhood, "Jones Falls Area");
  assert.equal(
    tc.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(tc.status, "verified");
  assert.equal(tc.address, "3300 Clipper Mill Road, Baltimore, MD 21211");
  assert.equal(tc.phone, "410-913-6374");
  assert.equal(tc.source_url, "https://truechesapeake.com/pages/menus");
  assert.equal(tc.source_type, "venue_website");
  assert.equal(tc.last_verified, "2026-08-21");
  assert.equal(tc.notes_public, "only at the bar & high tops.");
  assert.equal(tc.lat, 39.3268179);
  assert.equal(tc.lon, -76.6369016);
  assert.equal(tc.deals.length, 2);
  assert.match(tc.ops_notes ?? "", /Name=Jones Falls Area/);
  assert.match(tc.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(tc.ops_notes ?? "", /Do not invent a \/jones-falls-area/);
  assert.match(tc.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(tc.ops_notes ?? "", /city Name wins/);
  assert.match(tc.ops_notes ?? "", /Monday: Closed/);
  assert.match(tc.ops_notes ?? "", /do not copy onto the deal clock/i);
  assert.match(tc.ops_notes ?? "", /auto-gratuity of 20%/);
  assert.match(tc.ops_notes ?? "", /spicy chicken meatball/);
  assert.match(tc.ops_notes ?? "", /classic coddie/);
  assert.match(tc.ops_notes ?? "", /Tropical Tuesdays/);
  assert.ok(
    !tc.deals.some((d) => d.items.some((i) => /meatball|coddie|pearl diver|mai tai|zombie/i.test(i.text))),
    "$4 graphic food and Tropical Tuesdays stay off",
  );

  const sixDay = tc.deals.find((d) => d.days.length === 6);
  const wedWine = tc.deals.find(
    (d) => d.days.length === 1 && d.days[0] === "wed" && d.items.some((i) => /50% off select bottles/i.test(i.text)),
  );
  assert.ok(sixDay && wedWine, "expected six-day HH + Wednesday-only wine");
  assert.deepEqual(sixDay.days, ["tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(sixDay.start, 1020);
  assert.equal(sixDay.end, 1140);
  assert.equal(sixDay.time_window, "5pm-7pm");
  assert.equal(sixDay.happy_hour, true);
  assert.deepEqual(
    sixDay.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$6 daiquiris, martinis, margaritas & old fashioneds", "$6"],
      ["$5 select drafts", "$5"],
      ["$6 select wines", "$6"],
      ["$2 raw oysters", "$2"],
      ["$2 roasted oysters", "$2"],
    ],
  );
  assert.deepEqual(sixDay.food_categories, ["drink", "seafood/crab"]);
  assert.ok(
    !sixDay.items.some((i) => /50% off/i.test(i.text)),
    "Wednesday wine does not hang on the six-day row",
  );
  assert.equal(wedWine.start, 1020);
  assert.equal(wedWine.end, 1140);
  assert.equal(wedWine.time_window, "5pm-7pm");
  assert.equal(wedWine.happy_hour, true);
  assert.deepEqual(
    wedWine.items.map((i) => [i.text, i.price ?? null]),
    [["50% off select bottles of wine", "50% off"]],
  );
  assert.deepEqual(wedWine.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "true-chesapeake"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "true-chesapeake"),
    "Jones Falls Area must not fold into /hampden",
  );
  assert.equal(bySlug["jones-falls-area"], undefined, "do not invent a jones-falls-area view");
});

test("Valentino's Restaurant joins 2026-08-21 (Westfield citywide, Mon–Fri 3–7 HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const val = byId.valentinos;
  assert.ok(val, "valentinos missing");
  assert.deepEqual(venueShapeErrors(val), []);
  assert.equal(val.name, "Valentino's Restaurant");
  assert.equal(val.neighborhood, "Westfield");
  assert.equal(
    val.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(val.status, "verified");
  assert.equal(val.address, "6627 Harford Rd, Baltimore, MD 21214");
  assert.equal(val.phone, "(410) 254-4700");
  assert.equal(val.source_url, "https://www.valentinosbaltimore.com/happyhour/");
  assert.equal(val.source_type, "venue_website");
  assert.equal(val.last_verified, "2026-08-21");
  assert.equal(val.notes_public, "In-House only / Excluding Holidays.");
  assert.equal(val.lat, 39.3629187);
  assert.equal(val.lon, -76.5519198);
  assert.equal(val.deals.length, 1);
  assert.match(val.ops_notes ?? "", /Name=Westfield/);
  assert.match(val.ops_notes ?? "", /citywideOnly/);
  assert.match(val.ops_notes ?? "", /Do not invent a \/westfield/);
  assert.match(val.ops_notes ?? "", /Sun-Thur: 7am- 5am/);
  assert.match(val.ops_notes ?? "", /Fri & Sat: 24 hours/);
  assert.match(val.ops_notes ?? "", /do not copy onto the deal clock/i);
  assert.match(val.ops_notes ?? "", /Not valid with other offers, promotions or discounts\./);
  assert.match(val.ops_notes ?? "", /18% Gratuity Added To Each In-House Check/);
  assert.ok(
    !/Not valid with other offers/.test(val.notes_public),
    "stacking disclaimer stays in ops, not notes_public",
  );
  assert.ok(
    !/18% Gratuity/.test(val.notes_public),
    "18% grat stays in ops, not notes_public",
  );
  assert.ok(
    !val.deals.some((d) => d.items.some((i) => /Providence|Voodoo|Fra Diavolo/i.test(i.text))),
    "do not ship sauce names as extra items",
  );

  const hh = val.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "3pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Select wine, slushes, crushes, margaritas, martinis, cocktails", "$7"],
      ["Pub Wings", "$8"],
      ["Ravioli Tostati", "$7"],
      ["Bacon Cheddar Cups", "$7"],
      ["Thai Chili Shrimp", "$7"],
      ["Oyster in 1/2 Shell", "$10"],
      ["Clams in 1/2 Shell", "$8"],
      ["Cozze Bowl", "$10"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "wings", "small-plate/apps", "seafood/crab"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "valentinos"));
  assert.equal(bySlug.westfield, undefined, "do not invent a westfield view");
});

test("Wet City Brewing joins 2026-08-21 (Mid-Town Belvedere / mount-vernon, Mon–Thu all-night HH on bar hours)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const wet = byId["wet-city"];
  assert.ok(wet, "wet-city missing");
  assert.deepEqual(venueShapeErrors(wet), []);
  assert.equal(wet.name, "Wet City Brewing");
  assert.equal(wet.neighborhood, "Mid-Town Belvedere");
  assert.equal(
    wet.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(wet.status, "verified");
  assert.equal(wet.address, "223 W. Chase St. Baltimore, MD 21201");
  assert.equal(wet.phone, "443-873-6699");
  assert.equal(wet.source_url, "https://wetcitybrewing.com/");
  assert.equal(wet.source_type, "venue_website");
  assert.equal(wet.last_verified, "2026-08-21");
  assert.equal(wet.notes_public, undefined);
  assert.equal(wet.lat, 39.3016191);
  assert.equal(wet.lon, -76.6189682);
  assert.equal(wet.deals.length, 4);
  assert.match(wet.ops_notes ?? "", /Name=Mid-Town Belvedere/);
  assert.match(wet.ops_notes ?? "", /Already in \/mount-vernon/);
  assert.match(wet.ops_notes ?? "", /neighborhood_self_described/);
  assert.match(wet.ops_notes ?? "", /Monday – Wednesday: 5pm – 10pm \(Kitchen Closes @ 10pm\)/);
  assert.match(wet.ops_notes ?? "", /Thursday: 5pm – 11pm \(Kitchen Closes @ 10pm\)/);
  assert.match(wet.ops_notes ?? "", /Friday: 5pm – 12am \(Kitchen Closes @ 11pm\)/);
  assert.match(wet.ops_notes ?? "", /Saturday: 12pm – 11pm \(Kitchen Closes @ 10pm\)/);
  assert.match(wet.ops_notes ?? "", /Sunday omitted/);
  assert.match(wet.ops_notes ?? "", /Do not invent closed/);
  assert.match(wet.ops_notes ?? "", /do not copy kitchen-close onto a deal clock/i);
  assert.match(wet.ops_notes ?? "", /Special Wing Menu/);
  assert.ok(
    !/Mount Vernon/.test(wet.notes_public ?? ""),
    "do not write Mount Vernon into notes_public",
  );
  assert.ok(
    !wet.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
    '"all night" is the label, not a time_window string',
  );
  assert.ok(
    !wet.deals.some((d) => d.days.some((day) => day === "fri" || day === "sat")),
    "no Fri/Sat daily special published",
  );
  assert.ok(
    !wet.deals.some((d) => d.items.some((i) => /Special Wing Menu/i.test(i.text) && i.price)),
    "do not invent wing prices from Special Wing Menu",
  );

  const mon = wet.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = wet.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = wet.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = wet.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  assert.ok(mon && tue && wed && thu, "expected Mon / Tue / Wed / Thu rows");

  for (const d of [mon, tue, wed, thu]) {
    assert.equal(d.happy_hour, true);
    assert.equal(d.start, 1020);
  }
  assert.equal(mon.end, 1320);
  assert.equal(mon.time_window, "5pm-10pm");
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 off burgers", "$3 off"],
      ["$1 off -ish pours", "$1 off"],
    ],
  );
  assert.deepEqual(mon.food_categories, ["burger", "drink"]);

  assert.equal(tue.end, 1320);
  assert.equal(tue.time_window, "5pm-10pm");
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$3 off tacos & taco salad", "$3 off"],
      ["$10 Purple Margs", "$10"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["tacos", "drink"]);

  assert.equal(wed.end, 1320);
  assert.equal(wed.time_window, "5pm-10pm");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$10 Old Fashioned & Manhattans", "$10"],
      ["20% select whiskey pours", "20% off"],
      ["$3 off chix sandos", "$3 off"],
    ],
  );
  assert.deepEqual(wed.food_categories, ["drink", "sandwich/cheesesteak"]);

  assert.equal(thu.end, 1380);
  assert.equal(thu.time_window, "5pm-11pm");
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [["$3 off wings", "$3 off"]],
  );
  assert.deepEqual(thu.food_categories, ["wings"]);

  assert.ok(venuesInView(venues, bySlug["mount-vernon"]).some((v) => v.id === "wet-city"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "wet-city"));
});

test("Tabor Ethiopian Restaurant joins 2026-08-21 (Downtown / inner-harbor, Mon–Fri 4–7 HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const tabor = byId["tabor-ethiopian"];
  assert.ok(tabor, "tabor-ethiopian missing");
  assert.deepEqual(venueShapeErrors(tabor), []);
  assert.equal(tabor.name, "Tabor Ethiopian Restaurant");
  assert.equal(tabor.neighborhood, "Downtown");
  assert.equal(
    tabor.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(tabor.status, "verified");
  assert.equal(tabor.address, "328 Park Ave, Baltimore, MD 21201");
  assert.equal(tabor.phone, "(410) 528-7234");
  assert.equal(
    tabor.source_url,
    "https://taborethiopian.com/wp-content/uploads/2026/05/TaborMenu_4_26.pdf",
  );
  assert.equal(tabor.source_type, "venue_website");
  assert.equal(tabor.last_verified, "2026-08-21");
  assert.equal(tabor.notes_public, undefined);
  assert.equal(tabor.lat, 39.293806);
  assert.equal(tabor.lon, -76.6183705);
  assert.equal(tabor.deals.length, 1);
  assert.match(tabor.ops_notes ?? "", /Name=Downtown/);
  assert.match(tabor.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(tabor.ops_notes ?? "", /neighborhood_self_described/);
  assert.match(tabor.ops_notes ?? "", /Authentic Ethiopian Cuisine in the Heart of Mount Vernon Baltimore\./);
  assert.match(tabor.ops_notes ?? "", /2:00 OFF COCKTAILS/);
  assert.match(tabor.ops_notes ?? "", /\$2\.99/);
  assert.match(tabor.ops_notes ?? "", /\$3\.99/);
  assert.ok(
    !/Mount Vernon/.test(tabor.notes_public ?? ""),
    "do not write Mount Vernon into notes_public",
  );
  assert.ok(
    !tabor.deals.some((d) => d.items.some((i) => /\$2\.99|\$3\.99/.test(`${i.text} ${i.price ?? ""}`))),
    "regular menu sambusa prices are not the HH row",
  );
  assert.ok(
    !tabor.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
  );

  const hh = tabor.deals[0];
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "4pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$2 off cocktails", "$2 off"],
      ["Domestic beer", "$3.50"],
      ["Imported beer", "$4.50"],
      ["Ethiopian beer", "$4.75"],
      ["Select wines", "$8"],
      ["Tej/honey wine", "$8"],
      ["Veggie sambusa", "$2.50"],
      ["Beef sambusa", "$3"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "tabor-ethiopian"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "tabor-ethiopian"));
});

test("Marta Fine Food & Spirits joins 2026-08-21 (Upper Fells Point citywide, Tue–Fri 4–6 HH)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const marta = byId.marta;
  assert.ok(marta, "marta missing");
  assert.deepEqual(venueShapeErrors(marta), []);
  assert.equal(marta.name, "Marta Fine Food & Spirits");
  assert.equal(marta.neighborhood, "Upper Fells Point");
  assert.equal(
    marta.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(marta.status, "verified");
  assert.equal(marta.address, "2127 East Pratt St, Baltimore, MD 21231");
  assert.equal(marta.phone, "443-708-5962");
  assert.equal(
    marta.source_url,
    "https://www.martabaltimore.com/files/marta-happyhour-spring26-v06-pdf-17bede27.pdf",
  );
  assert.equal(marta.source_type, "venue_website");
  assert.equal(marta.last_verified, "2026-08-21");
  assert.equal(marta.notes_public, "Available at the bar and patio.");
  assert.equal(marta.lat, 39.2893675);
  assert.equal(marta.lon, -76.5862345);
  assert.equal(marta.deals.length, 1);
  assert.match(marta.ops_notes ?? "", /Name=Upper Fells Point/);
  assert.match(marta.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(marta.ops_notes ?? "", /Do not invent a \/upper-fells-point/);
  assert.match(marta.ops_notes ?? "", /Do not fold into \/fells-point/);
  assert.match(marta.ops_notes ?? "", /Cloudflare 403/);
  assert.match(marta.ops_notes ?? "", /Do not call closed/);
  assert.match(marta.ops_notes ?? "", /visual \+ text/);
  assert.match(marta.ops_notes ?? "", /spirit free/);
  assert.ok(
    !marta.deals.some((d) => d.items.some((i) => /golden hour|rhuby slipper|petals on pratt|classic negroni|cocktail of the week/i.test(i.text))),
    "do not ship recipe lines or invent cocktail of the week",
  );
  assert.ok(
    !/spirit free/i.test(marta.notes_public),
    "spirit-free clause stays in ops, not notes_public",
  );

  const hh = marta.deals[0];
  assert.deepEqual(hh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "4pm-6pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Spritzes", "$9"],
      ["Cocktails", "$11"],
      ["House wines", "$8"],
      ["Draft beer", "$6"],
      ["Bread & Butter", "$8"],
      ["Tuna Cannoli", "$10"],
      ["Yellowtail", "$10"],
      ["Oysters Scroppino", "$8"],
      ["Beef Tartare", "$15"],
      ["Arancini Milanese", "$10"],
      ["Sheep's Milk Ricotta", "$10"],
      ["Meatballs Arrabbiata", "$10"],
      ["Ziti alla Bolognese", "$13"],
      ["Campanelle Zafferano", "$17"],
      ["Risotto Milanese", "$14"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps", "seafood/crab"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "marta"));
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "marta"),
    "Upper Fells Point must not fold into /fells-point",
  );
  assert.equal(bySlug["upper-fells-point"], undefined, "do not invent an upper-fells-point view");
});

test("Maryland Yards joins 2026-08-21 (Downtown West citywide, Wed–Sat daily specials; Mon/Tue held)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const yards = byId["maryland-yards"];
  assert.ok(yards, "maryland-yards missing");
  assert.deepEqual(venueShapeErrors(yards), []);
  assert.equal(yards.name, "Maryland Yards");
  assert.equal(yards.neighborhood, "Downtown West");
  assert.equal(
    yards.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(yards.status, "verified");
  assert.equal(yards.address, "511 W Pratt Street, Baltimore, Maryland 21201");
  assert.equal(yards.phone, "443-835-4781");
  assert.equal(yards.source_url, "https://www.mdyards.com/daily-specials");
  assert.equal(yards.source_type, "venue_website");
  assert.equal(yards.last_verified, "2026-08-21");
  assert.equal(yards.notes_public, undefined);
  assert.equal(yards.lat, 39.2861328);
  assert.equal(yards.lon, -76.6226044);
  assert.equal(yards.deals.length, 4);
  assert.match(yards.ops_notes ?? "", /Name=Downtown West/);
  assert.match(yards.ops_notes ?? "", /citywideOnly/);
  assert.match(yards.ops_notes ?? "", /Do not invent a \/downtown-west/);
  assert.match(yards.ops_notes ?? "", /Do not fold into \/inner-harbor/);
  assert.match(yards.ops_notes ?? "", /marylandyards\.com is not this door/);
  assert.match(yards.ops_notes ?? "", /Mon: Closed/);
  assert.match(yards.ops_notes ?? "", /Tues: Closed/);
  assert.match(yards.ops_notes ?? "", /11am - 8pm/);
  assert.match(yards.ops_notes ?? "", /pending new menu 11am - 4pm/);
  assert.match(yards.ops_notes ?? "", /Extended hours on Orioles Game Days/);
  assert.match(yards.ops_notes ?? "", /do not copy 8pm onto a deal end/i);
  assert.match(yards.ops_notes ?? "", /coming-soon/);
  assert.match(yards.ops_notes ?? "", /We're shaking up the menu/);
  assert.match(yards.ops_notes ?? "", /Do not ship Monday or Tuesday/);
  assert.match(yards.ops_notes ?? "", /All Day Happy Hour has no \$/);
  assert.ok(
    !yards.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
    'do not write time_window: "all day"',
  );
  assert.ok(
    !yards.deals.some((d) => d.days.some((day) => day === "mon" || day === "tue" || day === "sun")),
    "do not ship Monday, Tuesday, or Sunday",
  );
  assert.ok(
    !yards.deals.some((d) => d.end === 1200),
    "do not copy hours-block 8pm onto a deal clock",
  );

  const wed = yards.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = yards.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const fri = yards.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  const sat = yards.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.ok(wed && thu && fri && sat, "expected Wed / Thu / Fri / Sat rows");

  for (const d of [wed, thu, fri, sat]) {
    assert.equal(d.happy_hour, true);
  }
  assert.equal(wed.start, 960);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, "4pm to close");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["Half off bottles of wine", "50% off"]],
  );
  assert.deepEqual(wed.food_categories, ["drink"]);

  assert.equal(thu.start, 960);
  assert.equal(thu.end, null);
  assert.equal(thu.time_window, "4pm to close");
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [["BOGO Whiskey", "BOGO"]],
  );
  assert.deepEqual(thu.food_categories, ["drink"]);

  assert.equal(fri.start, 960);
  assert.equal(fri.end, null);
  assert.equal(fri.time_window, "4pm to close");
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [["Half off flights (beer, wine, tequila)", "50% off"]],
  );
  assert.deepEqual(fri.food_categories, ["drink"]);

  assert.equal(sat.start, null);
  assert.equal(sat.end, null);
  assert.equal(sat.time_window, undefined);
  assert.deepEqual(
    sat.items.map((i) => [i.text, i.price ?? null]),
    [["$25 Beer Tower", "$25"]],
  );
  assert.deepEqual(sat.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "maryland-yards"));
  assert.ok(
    !venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "maryland-yards"),
    "Downtown West must not fold into /inner-harbor",
  );
  assert.equal(bySlug["downtown-west"], undefined, "do not invent a downtown-west view");
});

test("McCormick & Schmick's joins 2026-08-21 (Inner Harbor, Mon–Fri 3:30–6:30 + Daily Twist)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const ms = byId["mccormick-schmicks"];
  assert.ok(ms, "mccormick-schmicks missing");
  assert.deepEqual(venueShapeErrors(ms), []);
  assert.equal(ms.name, "McCormick & Schmick's");
  assert.equal(ms.neighborhood, "Inner Harbor");
  assert.equal(
    ms.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(ms.status, "verified");
  assert.equal(ms.address, "711 Eastern Ave, Baltimore, MD 21202");
  assert.equal(ms.phone, "(410) 234-1300");
  assert.equal(
    ms.source_url,
    "https://www.mccormickandschmicks.com/location/mccormick-schmicks-baltimore-md/",
  );
  assert.equal(ms.source_type, "venue_website");
  assert.equal(ms.last_verified, "2026-08-21");
  assert.equal(
    ms.notes_public,
    "Not available for carryout. Not valid on holidays. Minimum beverage purchase of $3.4 per person.",
  );
  assert.equal(ms.lat, 39.2843797);
  assert.equal(ms.lon, -76.6056651);
  assert.equal(ms.deals.length, 4);
  assert.match(ms.ops_notes ?? "", /Name=Inner Harbor/);
  assert.match(ms.ops_notes ?? "", /Already in \/inner-harbor/);
  assert.match(ms.ops_notes ?? "", /#happy-hour-msba/);
  assert.match(ms.ops_notes ?? "", /Do not cite/);
  assert.match(ms.ops_notes ?? "", /happy-hour-menu-jkcr/);
  assert.match(ms.ops_notes ?? "", /SUN - THU: 11:30 AM - 9:00 PM/);
  assert.match(ms.ops_notes ?? "", /FRI - SAT: 11:30 AM - 10:00 PM/);
  assert.match(ms.ops_notes ?? "", /Happy Hour: Mon - Fri 3:30PM - 6:30PM/);
  assert.match(ms.ops_notes ?? "", /bar and lounge/);
  assert.match(ms.ops_notes ?? "", /\$3\.4/);
  assert.doesNotMatch(ms.source_url, /happy-hour-menu-jkcr/);
  assert.ok(
    !ms.deals.some((d) => (d.source_url ?? "").includes("happy-hour-menu-jkcr")),
    "do not cite brand-wide HH menu",
  );
  assert.ok(
    !ms.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
  );

  const hh = ms.deals.find((d) => d.days.length === 5 && d.days[0] === "mon");
  const taco = ms.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const poke = ms.deals.find((d) => d.days.length === 2 && d.days.includes("wed") && d.days.includes("thu"));
  const shuck = ms.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.ok(hh && taco && poke && shuck, "expected HH + three Daily Twist rows");

  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 930);
  assert.equal(hh.end, 1110);
  assert.equal(hh.time_window, "3:30pm-6:30pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Cheesy Chowder Fries", "$8"],
      ["Korean Fried Chicken", "$8"],
      ["Wagyu Carpaccio", "$8"],
      ["Blue Cheese Chips", "$8"],
      ["Crispy Asian Calamari", "$10"],
      ["Fish Tacos Al Pastor Style", "$10"],
      ["Spicy Asian Shrimp Tacos", "$10"],
      ["Coconut Shrimp", "$10"],
      ["Cheeseburger", "$12"],
      ["Poke Tuna Chips", "$12"],
      ["Prosciutto di Parma Flatbread", "$12"],
      ["Spice Seared Ahi Tuna", "$14"],
      ["Chilled Shrimp Cocktail", "$14"],
      ["Sweet & Spicy Chicken Wings", "$14"],
      ["P.E.I. Black Mussels", "$14"],
      ["Draught beer — domestic & specialty", "$5"],
      ["Draught beer — import & craft", "$6"],
      ["Well spirits", "$7"],
      ["American craft spirits", "$8.5"],
      ["Select wines", "$7"],
      ["Premium wines", "$9"],
      ["Gold Margarita", "$9"],
      ["M&S Iced Tea", "$11"],
      ["Berry Berry Mojito", "$10"],
      ["Perfect Lemon Drop Martini", "$10"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps", "seafood/crab", "burger"]);

  assert.equal(taco.happy_hour, true);
  assert.equal(taco.start, 930);
  assert.equal(taco.end, null);
  assert.equal(taco.time_window, "3:30pm-close");
  assert.deepEqual(
    taco.items.map((i) => [i.text, i.price ?? null]),
    [["$3 fish or shrimp tacos", "$3"]],
  );
  assert.deepEqual(taco.food_categories, ["tacos"]);
  assert.match(taco.proof_quote ?? "", /bar and lounge/);

  assert.deepEqual(poke.days, ["wed", "thu"]);
  assert.equal(poke.happy_hour, true);
  assert.equal(poke.start, 930);
  assert.equal(poke.end, null);
  assert.equal(poke.time_window, "3:30pm-close");
  assert.deepEqual(
    poke.items.map((i) => [i.text, i.price ?? null]),
    [["$10 Ahi Tuna Poke", "$10"]],
  );
  assert.deepEqual(poke.food_categories, ["seafood/crab"]);
  assert.match(poke.proof_quote ?? "", /bar and lounge/);

  assert.equal(shuck.happy_hour, true);
  assert.equal(shuck.start, 930);
  assert.equal(shuck.end, null);
  assert.equal(shuck.time_window, "3:30pm-close");
  assert.deepEqual(
    shuck.items.map((i) => [i.text, i.price ?? null]),
    [["$2 Buck Shuck or Shrimp", "$2"]],
  );
  assert.deepEqual(shuck.food_categories, ["seafood/crab"]);
  assert.match(shuck.proof_quote ?? "", /bar and lounge/);

  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "mccormick-schmicks"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "mccormick-schmicks"));
});

test("Midlina joins 2026-08-21 (Canton / canton, Thursday $30 select bottles)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const midlina = byId.midlina;
  assert.ok(midlina, "midlina missing");
  assert.deepEqual(venueShapeErrors(midlina), []);
  assert.equal(midlina.name, "Midlina");
  assert.equal(midlina.neighborhood, "Canton");
  assert.equal(
    midlina.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(midlina.status, "verified");
  assert.equal(midlina.address, "2206 Boston St, Baltimore, MD 21231");
  assert.equal(midlina.phone, "(410)-775-4094");
  assert.equal(midlina.source_url, "https://midlinarestaurant.com/specials");
  assert.equal(midlina.source_type, "venue_website");
  assert.equal(midlina.last_verified, "2026-08-21");
  assert.equal(midlina.notes_public, undefined);
  assert.equal(midlina.lat, 39.2838396);
  assert.equal(midlina.lon, -76.5852577);
  assert.equal(midlina.deals.length, 1);
  assert.match(midlina.ops_notes ?? "", /Name=Canton/);
  assert.match(midlina.ops_notes ?? "", /Already in \/canton/);
  assert.match(midlina.ops_notes ?? "", /Do not add Canton to citywideOnly/);
  assert.match(midlina.ops_notes ?? "", /21231/);
  assert.match(midlina.ops_notes ?? "", /Tue, Wed, Thur 5:00 PM - 11:00 PM/);
  assert.match(midlina.ops_notes ?? "", /Fri, Sat 5:00 PM - 1:00 AM/);
  assert.match(midlina.ops_notes ?? "", /Sun 4:00 PM - 9:30 PM/);
  assert.match(midlina.ops_notes ?? "", /Monday omitted/);
  assert.match(midlina.ops_notes ?? "", /00:00/);
  assert.match(midlina.ops_notes ?? "", /Do not invent closed/);
  assert.match(midlina.ops_notes ?? "", /Do not copy Friday 1am onto the Thursday clock/);
  assert.match(midlina.ops_notes ?? "", /Happy Hour 5-7 Bar Only/);
  assert.match(midlina.ops_notes ?? "", /Happy Hour 4-6/);
  assert.match(midlina.ops_notes ?? "", /Happy Hour 7-9/);
  assert.match(midlina.ops_notes ?? "", /Wednesday is not on the official specials page/);
  assert.match(midlina.ops_notes ?? "", /Do not ship times-only/);
  assert.ok(
    !midlina.deals.some((d) => d.days.some((day) => day === "tue" || day === "fri" || day === "sun" || day === "wed")),
    "do not ship Tue / Fri / Sun times-only HH or invent Wednesday",
  );
  assert.ok(
    !midlina.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
  );
  assert.ok(
    !midlina.deals.some((d) => d.end === 1500 || d.end === 60),
    "do not copy Friday 1am onto a deal clock",
  );

  const thu = midlina.deals[0];
  assert.deepEqual(thu.days, ["thu"]);
  assert.equal(thu.start, 1020);
  assert.equal(thu.end, 1380);
  assert.equal(thu.time_window, "5pm-11pm");
  assert.equal(thu.happy_hour, true);
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price ?? null]),
    [["$30 select bottles of wine", "$30"]],
  );
  assert.deepEqual(thu.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "midlina"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "midlina"));
});

test("Mt. Washington Tavern joins 2026-08-21 (Mount Washington citywide, 3–6 HH; dated food/wine/Sunday held)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const mwt = byId["mt-washington-tavern"];
  assert.ok(mwt, "mt-washington-tavern missing");
  assert.deepEqual(venueShapeErrors(mwt), []);
  assert.equal(mwt.name, "Mt. Washington Tavern");
  assert.equal(mwt.neighborhood, "Mount Washington");
  assert.equal(
    mwt.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(mwt.status, "verified");
  assert.equal(mwt.address, "5700 Newbury Street, Baltimore, MD 21209");
  assert.equal(mwt.phone, "(410)-367-6903");
  assert.equal(
    mwt.source_url,
    "https://www.mtwashingtontavern.com/baltimore-mt-washington-mt-washington-tavern-happy-hours-specials",
  );
  assert.equal(mwt.source_type, "venue_website");
  assert.equal(mwt.last_verified, "2026-08-21");
  assert.equal(
    mwt.notes_public,
    "Thursday complimentary oysters require a food or drink purchase.",
  );
  assert.equal(mwt.lat, 39.3673874);
  assert.equal(mwt.lon, -76.6525059);
  assert.equal(mwt.deals.length, 3);
  assert.match(mwt.ops_notes ?? "", /Name=Mount Washington/);
  assert.match(mwt.ops_notes ?? "", /citywideOnly/);
  assert.match(mwt.ops_notes ?? "", /Do not invent a \/mount-washington/);
  assert.match(mwt.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(mwt.ops_notes ?? "", /bars open until 11pm/);
  assert.match(mwt.ops_notes ?? "", /bars open until midnight/);
  assert.match(mwt.ops_notes ?? "", /BRUNCH/);
  assert.match(mwt.ops_notes ?? "", /Open 364 days! \(Closed on Christmas\.\)/);
  assert.match(mwt.ops_notes ?? "", /do not copy bars open until or kitchen-close onto a deal clock/i);
  assert.match(mwt.ops_notes ?? "", /Friday August 21st/);
  assert.match(mwt.ops_notes ?? "", /Thursday August 27th/);
  assert.match(mwt.ops_notes ?? "", /Saturday has no specials block/);
  assert.match(mwt.ops_notes ?? "", /GIRL DINNER/);
  assert.match(mwt.ops_notes ?? "", /Adele, Samantha & Jamar/);
  assert.match(mwt.ops_notes ?? "", /Half-price Tavern Burgers served with house chips \(dine-in only\)/);
  assert.match(mwt.ops_notes ?? "", /\$18 Fish Market/);
  assert.match(mwt.ops_notes ?? "", /\$32 Prime Rib/);
  assert.match(mwt.ops_notes ?? "", /Half-price bottles of wine from open to close!/);
  assert.match(mwt.ops_notes ?? "", /\$4\.40/);
  assert.match(mwt.ops_notes ?? "", /\(NA\)/);
  assert.ok(
    !mwt.deals.some((d) => d.days.includes("sun") || d.days.includes("sat")),
    "do not ship Saturday (none) or Sunday dated rows",
  );
  assert.ok(
    !mwt.deals.some((d) =>
      d.items.some((i) =>
        /girl dinner|crush|tavern burger|fish market|prime rib|half-price bottles of wine/i.test(i.text),
      ),
    ),
    "dated-board food/wine/Sunday rows stay off",
  );
  assert.ok(
    !mwt.deals.some((d) => d.time_window === "all night" || d.time_window === "all day"),
  );
  assert.ok(
    !mwt.deals.some((d) => d.end === 1260 || d.end === 1320 || d.end === 1440 || d.end === 1380),
    "do not copy kitchen-close or bars-open-until onto a deal clock",
  );
  assert.ok(
    !/dine-in only/i.test(mwt.notes_public),
    "dine-in-only language stays off the card until dated rows ship",
  );

  const drinks = mwt.deals.find(
    (d) => d.days.length === 5 && d.days[0] === "mon" && d.food_categories?.length === 1,
  );
  const oysters = mwt.deals.find(
    (d) => d.days.length === 4 && d.days.includes("mon") && !d.days.includes("thu"),
  );
  const thuOysters = mwt.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  assert.ok(drinks && oysters && thuOysters, "expected drinks + MTWF oysters + Thursday oysters");

  assert.deepEqual(drinks.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(drinks.start, 900);
  assert.equal(drinks.end, 1080);
  assert.equal(drinks.time_window, "3pm-6pm");
  assert.equal(drinks.happy_hour, true);
  assert.deepEqual(
    drinks.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$10 Martinis, Old Fashioneds, Manhattans & Garden Spritzes (NA)", "$10"],
      ["House wines", "$6"],
      ["Select drafts", "$4.40"],
    ],
  );
  assert.deepEqual(drinks.food_categories, ["drink"]);

  assert.deepEqual(oysters.days, ["mon", "tue", "wed", "fri"]);
  assert.equal(oysters.start, 900);
  assert.equal(oysters.end, 1080);
  assert.equal(oysters.time_window, "3pm-6pm");
  assert.equal(oysters.happy_hour, true);
  assert.deepEqual(
    oysters.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$1 oysters", "$1"],
      ["Exclusive apps starting at $8", "$8"],
    ],
  );
  assert.deepEqual(oysters.food_categories, ["seafood/crab", "small-plate/apps"]);

  assert.equal(thuOysters.happy_hour, true);
  assert.equal(thuOysters.start, 900);
  assert.equal(thuOysters.end, 1080);
  assert.equal(thuOysters.time_window, "3pm-6pm");
  assert.deepEqual(
    thuOysters.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Complimentary oysters with a food or drink purchase", "Free"],
      ["Exclusive apps starting at $8", "$8"],
    ],
  );
  assert.deepEqual(thuOysters.food_categories, ["seafood/crab", "small-plate/apps"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "mt-washington-tavern"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "mt-washington-tavern"),
    "Mount Washington must not fold into /hampden",
  );
  assert.equal(bySlug["mount-washington"], undefined, "do not invent a mount-washington view");
});

test("Nepenthe Brewing joins 2026-08-21 (Hampden / hampden, Tue all-night + Wed/Thu 5–7; Monday dropped)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const nep = byId["nepenthe-brewing"];
  assert.ok(nep, "nepenthe-brewing missing");
  assert.deepEqual(venueShapeErrors(nep), []);
  assert.equal(nep.name, "Nepenthe Brewing Co.");
  assert.equal(nep.neighborhood, "Hampden");
  assert.equal(
    nep.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(nep.status, "verified");
  assert.equal(nep.address, "3626 Falls Road, Baltimore, MD 21211");
  assert.equal(nep.phone, "(443) 438-4846");
  assert.equal(nep.source_url, "https://www.nepenthebrewingco.com/happy-hour");
  assert.equal(nep.source_type, "venue_website");
  assert.equal(nep.last_verified, "2026-08-21");
  assert.equal(nep.notes_public, undefined);
  assert.equal(nep.lat, 39.3314965);
  assert.equal(nep.lon, -76.6352889);
  assert.equal(nep.deals.length, 2);
  assert.match(nep.ops_notes ?? "", /Name=Hampden/);
  assert.match(nep.ops_notes ?? "", /Already in \/hampden/);
  assert.match(nep.ops_notes ?? "", /Do not add Hampden to citywideOnly/);
  assert.match(nep.ops_notes ?? "", /3622-26 Falls/);
  assert.match(nep.ops_notes ?? "", /WEB_HH MENU\.png/);
  assert.match(nep.ops_notes ?? "", /no Monday/);
  assert.match(nep.ops_notes ?? "", /17:00–21:00/);
  assert.match(nep.ops_notes ?? "", /17:00–22:00/);
  assert.match(nep.ops_notes ?? "", /12:00–22:00/);
  assert.match(nep.ops_notes ?? "", /12:00–17:00/);
  assert.match(nep.ops_notes ?? "", /drop Monday/);
  assert.match(nep.ops_notes ?? "", /Manic Mondays! All night specials \+ Happy Hour 5-7pm/);
  assert.match(nep.ops_notes ?? "", /TUESDAYS All Night Happy Hour/);
  assert.match(nep.ops_notes ?? "", /Doodle Club/);
  assert.match(nep.ops_notes ?? "", /D&D/);
  assert.match(nep.ops_notes ?? "", /Friday is not on the graphic/);
  assert.match(nep.ops_notes ?? "", /Dietary v \/ vg/);
  assert.match(nep.ops_notes ?? "", /Do not copy Nepenthe's 9pm close/);
  assert.match(nep.ops_notes ?? "", /\/hours-location and \/contact-us still 404/);
  assert.ok(
    !nep.deals.some((d) => d.days.includes("mon") || d.days.includes("fri") || d.days.includes("sat") || d.days.includes("sun")),
    "do not invent a Monday Nepenthe row or ship Friday/weekend",
  );
  assert.ok(
    !nep.deals.some((d) => d.end === 1260 || d.end === 1320),
    "do not copy Nepenthe's 9pm (or 10pm Friday) close onto a deal clock",
  );

  const items = [
    ["Pint of the Day", "$7"],
    ["Rail drinks", "$9"],
    ["House Mac 'n Cheese", "$9"],
    ["All wine", "$11"],
    ["Chips & Beer Cheese Queso", "$11"],
    ["Special fries", "$13"],
    ["Tater Totchos", "$13"],
    ["Single Drive Thru Burger", "$13"],
    ["Buffalo Chicken Sandwich", "$13"],
    ["Crispy Tofu Sandwich", "$13"],
    ["Add fries to any sandwich", "$3"],
  ];
  const cats = ["drink", "burger", "sandwich/cheesesteak", "small-plate/apps"];

  const tue = nep.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wedThu = nep.deals.find((d) => d.days.length === 2 && d.days[0] === "wed");
  assert.ok(tue && wedThu, "expected Tuesday all-night + Wed/Thu 5–7");

  assert.equal(tue.start, 1020);
  assert.equal(tue.end, null);
  assert.equal(tue.time_window, "all night");
  assert.equal(tue.happy_hour, true);
  assert.deepEqual(tue.items.map((i) => [i.text, i.price ?? null]), items);
  assert.deepEqual(tue.food_categories, cats);

  assert.deepEqual(wedThu.days, ["wed", "thu"]);
  assert.equal(wedThu.start, 1020);
  assert.equal(wedThu.end, 1140);
  assert.equal(wedThu.time_window, "5pm-7pm");
  assert.equal(wedThu.happy_hour, true);
  assert.deepEqual(wedThu.items.map((i) => [i.text, i.price ?? null]), items);
  assert.deepEqual(wedThu.food_categories, cats);

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "nepenthe-brewing"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "nepenthe-brewing"));
});

test("Octobar joins 2026-08-21 (South Baltimore / federal-hill, Tue–Fri 4–7; Taco/Pasta/Game Day off)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const octo = byId.octobar;
  assert.ok(octo, "octobar missing");
  assert.deepEqual(venueShapeErrors(octo), []);
  assert.equal(octo.name, "Octobar");
  assert.equal(octo.neighborhood, "South Baltimore");
  assert.equal(
    octo.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(octo.status, "verified");
  assert.equal(octo.address, "1400 Light Street, Baltimore, MD 21230");
  assert.equal(octo.phone, "443-438-7599");
  assert.equal(octo.source_url, "https://octobarbaltimore.com/happy-hour-3/");
  assert.equal(octo.source_type, "venue_website");
  assert.equal(octo.last_verified, "2026-08-21");
  assert.equal(octo.notes_public, undefined);
  assert.equal(octo.lat, 39.2741273);
  assert.equal(octo.lon, -76.6121847);
  assert.equal(octo.deals.length, 1);
  assert.match(octo.ops_notes ?? "", /Name=South Baltimore/);
  assert.match(octo.ops_notes ?? "", /Already in \/federal-hill/);
  assert.match(octo.ops_notes ?? "", /Do not add South Baltimore to citywideOnly/);
  assert.match(octo.ops_notes ?? "", /Do not invent a \/south-baltimore/);
  assert.match(octo.ops_notes ?? "", /Do not fold into \/locust-point/);
  assert.match(octo.ops_notes ?? "", /citywide-only/);
  assert.match(octo.ops_notes ?? "", /Row House Grille/);
  assert.match(octo.ops_notes ?? "", /Monday Closed/);
  assert.match(octo.ops_notes ?? "", /4:00 pm - 10:00 pm/);
  assert.match(octo.ops_notes ?? "", /4:00 pm - 11:00 pm/);
  assert.match(octo.ops_notes ?? "", /4:00 pm - 2:00 am/);
  assert.match(octo.ops_notes ?? "", /11:00 am - 2:00 am/);
  assert.match(octo.ops_notes ?? "", /11:00 am - 10:00 pm/);
  assert.match(octo.ops_notes ?? "", /11:00 am - 4:00 pm/);
  assert.match(octo.ops_notes ?? "", /Do not copy Friday 2am/);
  assert.match(octo.ops_notes ?? "", /Monday through Friday 4:00 pm - 7:00 pm/);
  assert.match(octo.ops_notes ?? "", /Closed Mondays/);
  assert.match(octo.ops_notes ?? "", /4 to 7 - Tuesday to Friday/);
  assert.match(octo.ops_notes ?? "", /Happy-Hour-red\.png/);
  assert.match(octo.ops_notes ?? "", /TAPAS - 8/);
  assert.match(octo.ops_notes ?? "", /TAPAS - 6/);
  assert.match(octo.ops_notes ?? "", /tomate/);
  assert.match(octo.ops_notes ?? "", /Taco Tuesday/);
  assert.match(octo.ops_notes ?? "", /Pasta Night/);
  assert.match(octo.ops_notes ?? "", /Game Day Orioles/);
  assert.ok(
    !octo.deals.some((d) => d.days.includes("mon") || d.days.includes("sat") || d.days.includes("sun")),
    "do not ship Monday or weekend from the stale homepage Mon–Fri line",
  );
  assert.ok(
    !octo.deals.some((d) =>
      d.items.some((i) => /taco tuesday|pasta night|orioles|game day/i.test(i.text)),
    ),
    "Taco Tuesday / Pasta Night / Game Day stay off",
  );
  assert.ok(
    !octo.deals.some((d) => d.end === 1500 || d.end === 1560 || d.end === 120 || d.end === 60),
    "do not copy Friday 2am onto the HH clock",
  );

  const hh = octo.deals[0];
  assert.deepEqual(hh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "4pm-7pm");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Sangrias, wine, draft and Prosecco", "$5"],
      ["Margarita Bar (all flavors)", "$7"],
      ["Crushes (all flavors)", "$7"],
      ["Specialty Cocktail of the Day", "$8"],
      ["All bottles of wine", "$22"],
      ["Grilled Chicken Kabab", "$8"],
      ["Smoked Salmon Bruschetta", "$8"],
      ["Mediterranean Meatballs Shakshuka", "$8"],
      ["Grilled Chicken Pita Pizza", "$8"],
      ["Spinach Pies with Feta", "$8"],
      ["Grape Leaves stuffed with rice", "$8"],
      ["Cheese Ravioli", "$8"],
      ["Firecracker Shrimp", "$8"],
      ["Papas Bravas", "$6"],
      ["5 Pan con tomate", "$6"],
      ["Grilled Street Corn", "$6"],
      ["Warm Olives", "$6"],
      ["Deviled Eggs of the Day (4 pieces)", "$6"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);

  assert.ok(venuesInView(venues, bySlug["federal-hill"]).some((v) => v.id === "octobar"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "octobar"));
  assert.ok(
    !venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "octobar"),
    "Octobar must not fold into /locust-point",
  );
  assert.equal(bySlug["south-baltimore"], undefined, "do not invent a south-baltimore view");
});

test("Alexander's Tavern Soha joins 2026-08-21 (Waltherson citywide; do not mix Fells door)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const soha = byId["alexanders-tavern-soha"];
  assert.ok(soha, "alexanders-tavern-soha missing");
  assert.deepEqual(venueShapeErrors(soha), []);
  assert.equal(soha.name, "Alexander's Tavern Soha");
  assert.equal(soha.neighborhood, "Waltherson");
  assert.equal(
    soha.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(soha.status, "verified");
  assert.equal(soha.address, "4801 Harford Rd, Baltimore, MD 21214");
  assert.equal(soha.phone, "443-835-2071");
  assert.equal(soha.source_url, "https://www.alexanderstavern.com/sohaunion");
  assert.equal(soha.source_type, "venue_website");
  assert.equal(soha.last_verified, "2026-08-21");
  assert.equal(soha.notes_public, undefined);
  assert.equal(soha.lat, 39.3447319);
  assert.equal(soha.lon, -76.5673653);
  assert.equal(soha.deals.length, 7);
  assert.match(soha.ops_notes ?? "", /Name=Waltherson/);
  assert.match(soha.ops_notes ?? "", /already in citywideOnly/i);
  assert.match(soha.ops_notes ?? "", /Do not invent a \/waltherson/);
  assert.match(soha.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(soha.ops_notes ?? "", /Do not fold into \/fells-point/);
  assert.match(soha.ops_notes ?? "", /Do not mix doors/);
  assert.match(soha.ops_notes ?? "", /alexanders-tavern-fells/);
  assert.match(soha.ops_notes ?? "", /710 S\. Broadway/);
  assert.match(soha.ops_notes ?? "", /papistacojoint\.com\/soha-union HTTP 404/);
  assert.match(soha.ops_notes ?? "", /Lauraville/);
  assert.match(soha.ops_notes ?? "", /Hamilton/);
  assert.match(soha.ops_notes ?? "", /Yelp/);
  assert.match(soha.ops_notes ?? "", /soho/);
  assert.match(soha.ops_notes ?? "", /AlexandersTavernSoHa@gmail.com/);
  assert.match(soha.ops_notes ?? "", /Papi's Taco Lauraville/);
  assert.match(soha.ops_notes ?? "", /Suite H1/);
  assert.match(soha.ops_notes ?? "", /Animal Boy/);
  assert.match(soha.ops_notes ?? "", /3pm- 10pm/);
  assert.match(soha.ops_notes ?? "", /11:30am - 10pm/);
  assert.match(soha.ops_notes ?? "", /Do not copy Soha's 10pm close/);
  assert.match(soha.ops_notes ?? "", /RISE & SHINE/);
  assert.match(soha.ops_notes ?? "", /Build-Your-Own Mac & Cheese/);
  assert.match(soha.ops_notes ?? "", /Build-Your-Own Grilled Cheese/);
  assert.match(soha.ops_notes ?? "", /Wednesday Natty Light is on both/);
  assert.match(soha.ops_notes ?? "", /SOHA UNION HAPPY HOUR/);
  assert.equal(
    venues.filter((v) => v.id === "alexanders-tavern-fells").length,
    1,
    "do not touch alexanders-tavern-fells",
  );
  assert.equal(byId["alexanders-tavern-fells"].address, "710 S. Broadway, Baltimore, MD 21231");
  assert.ok(
    !soha.deals.some((d) =>
      d.items.some((i) => /Bud Light|Prosecco|Cheese Curds|chips with salsa|\$11 Alexander/i.test(i.text)),
    ),
    "do not copy Fells Point Alexander windows or items onto Soha",
  );
  assert.ok(
    !soha.deals.some((d) => d.days.includes("sat") || d.days.includes("sun")),
    "weekend Rise & Shine stays off (priced, no clock on this door)",
  );
  assert.ok(
    !soha.deals.some((d) =>
      d.items.some((i) => /Build-Your-Own Mac|Build-Your-Own Grilled Cheese|Mimosas|Bloody Marys|Fresh Fruit Crushes/i.test(i.text)),
    ),
    "Thursday unpriced mac/grilled cheese and weekend Rise & Shine stay off",
  );
  assert.ok(
    !soha.deals.some((d) => d.end === 1320 || d.end === 1380),
    "do not copy Soha's 10pm close onto a deal clock",
  );

  const hhItems = [
    ["$1 Off All Bottles and Cans", "$1 off"],
    ["$3 Off Glasses of Wine", "$3 off"],
    ["$2 Natty Light Drafts ($3 Big Drafts)", "$2"],
    ["$5 All Other Drafts ($8 Big Drafts)", "$5"],
    ["$5 Mixed House Drinks", "$5"],
    ["$6 Deep Eddy Vodka Drinks", "$6"],
    ["$6 Select Flavored Bombs", "$6"],
    ["$7 Texas Mules", "$7"],
    ["$4 Boardwalk Fries or Tater Tots with your choice of sauce", "$4"],
    ["$5 Cheesy Tots with Ranch", "$5"],
    ["$6 Brussels Sprouts (Maple-Bacon, Honey-Sriracha, or Buffalo-Bleu)", "$6"],
    ["$6 Alexander's Mac n' Cheese", "$6"],
    ["$6 Soft Pretzels & Queso", "$6"],
    ["$6 Cheese Quesadilla", "$6"],
    ["$8 Chicken Tenders and Fries", "$8"],
    ["$8 French Onion Soup", "$8"],
    ["$9 Cream of Crab Soup", "$9"],
  ];
  const hhCats = ["small-plate/apps", "pretzel", "pasta/comfort", "drink", "seafood/crab"];
  const friItems = [...hhItems, ["$4 Off all Flatbreads", "$4 off"]];
  const friCats = [...hhCats, "pizza"];

  const monWed = soha.deals.find((d) => d.happy_hour === true && d.days.length === 3 && d.days[0] === "mon");
  const thuHh = soha.deals.find((d) => d.happy_hour === true && d.days.length === 1 && d.days[0] === "thu");
  const friHh = soha.deals.find((d) => d.happy_hour === true && d.days.length === 1 && d.days[0] === "fri");
  assert.ok(monWed && thuHh && friHh, "expected Mon–Wed 3–6, Thu 2–6, Fri all-day-until-6 HH");

  assert.deepEqual(monWed.days, ["mon", "tue", "wed"]);
  assert.equal(monWed.start, 900);
  assert.equal(monWed.end, 1080);
  assert.equal(monWed.time_window, "3pm-6pm");
  assert.deepEqual(monWed.items.map((i) => [i.text, i.price ?? null]), hhItems);
  assert.deepEqual(monWed.food_categories, hhCats);

  assert.deepEqual(thuHh.days, ["thu"]);
  assert.equal(thuHh.start, 840);
  assert.equal(thuHh.end, 1080);
  assert.equal(thuHh.time_window, "2pm-6pm");
  assert.deepEqual(thuHh.items.map((i) => [i.text, i.price ?? null]), hhItems);
  assert.deepEqual(thuHh.food_categories, hhCats);

  assert.deepEqual(friHh.days, ["fri"]);
  assert.equal(friHh.start, null);
  assert.equal(friHh.end, 1080);
  assert.equal(friHh.time_window, "all day until 6pm");
  assert.deepEqual(friHh.items.map((i) => [i.text, i.price ?? null]), friItems);
  assert.deepEqual(friHh.food_categories, friCats);

  const mon = soha.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "mon");
  const tue = soha.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "tue");
  const wed = soha.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "wed");
  const thuDaily = soha.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "thu");
  assert.ok(mon && tue && wed && thuDaily, "expected four daily (non-HH) rows");

  for (const row of [mon, tue, wed, thuDaily]) {
    assert.equal(row.start, null);
    assert.equal(row.end, null);
    assert.equal(row.time_window, "all day");
  }
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$10 Alexander's Cheeseburgers", "$10"],
      ["$5 Microbrew Bottles & Cans", "$5"],
      ["Kids Eat Free After 4pm (With Adult Meal Purchase)", "Free"],
    ],
  );
  assert.deepEqual(mon.food_categories, ["burger", "drink"]);
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Half Price Tater Tots Dishes", "1/2 price"],
      ["$10 Martini Menu", "$10"],
    ],
  );
  assert.deepEqual(tue.food_categories, ["small-plate/apps", "drink"]);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$10 Charm City Wings", "$10"],
      ["$2 Natty Light Drafts", "$2"],
      ["$3 Natty Boh BIG Cans", "$3"],
    ],
  );
  assert.deepEqual(wed.food_categories, ["wings", "drink"]);
  assert.deepEqual(
    thuDaily.items.map((i) => [i.text, i.price ?? null]),
    [
      ["B.O.G.O. Glasses of Wine", "BOGO"],
      ["1/2 Price Bottles of Wine", "1/2 price"],
    ],
  );
  assert.deepEqual(thuDaily.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "alexanders-tavern-soha"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "alexanders-tavern-soha"),
    "Soha must not fold into /hampden",
  );
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "alexanders-tavern-soha"),
    "Soha must not fold into /fells-point",
  );
  assert.equal(bySlug.waltherson, undefined, "do not invent a waltherson view");
});

test("Rec Pier Chop House joins 2026-08-21 (Fells Point / fells-point, Martini Hour + Tasting Tuesdays)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const rec = byId["rec-pier-chop-house"];
  assert.ok(rec, "rec-pier-chop-house missing");
  assert.deepEqual(venueShapeErrors(rec), []);
  assert.equal(rec.name, "Rec Pier Chop House");
  assert.equal(rec.neighborhood, "Fells Point");
  assert.equal(
    rec.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(rec.status, "verified");
  assert.equal(rec.address, "1715 Thames Street, Baltimore, MD 21231");
  assert.equal(rec.phone, "(443) 552-1300");
  assert.equal(rec.source_url, "https://www.pendry.com/baltimore/menus/martini-hour/");
  assert.equal(rec.source_type, "venue_website");
  assert.equal(rec.last_verified, "2026-08-21");
  assert.equal(rec.notes_public, undefined);
  assert.equal(rec.lat, 39.2811103);
  assert.equal(rec.lon, -76.5919083);
  assert.equal(rec.deals.length, 2);
  assert.match(rec.ops_notes ?? "", /Name=Fells Point/);
  assert.match(rec.ops_notes ?? "", /Already in \/fells-point/);
  assert.match(rec.ops_notes ?? "", /Do not add Fells Point to citywideOnly/);
  assert.match(rec.ops_notes ?? "", /\(443\) 552-1400/);
  assert.match(rec.ops_notes ?? "", /pendry\.com\/baltimore\/dining\/rec-pier-chop-house/);
  assert.match(rec.ops_notes ?? "", /recpierchophouse\.com\/seasonal-happenings/);
  assert.match(rec.ops_notes ?? "", /7:00am – 10:30am/);
  assert.match(rec.ops_notes ?? "", /11:00am – 3:00pm/);
  assert.match(rec.ops_notes ?? "", /5:00pm – 10:00pm/);
  assert.match(rec.ops_notes ?? "", /11:00am – 10:00pm/);
  assert.match(rec.ops_notes ?? "", /11:00am – 11:00pm/);
  assert.match(rec.ops_notes ?? "", /Do not copy dinner-close or lounge 11pm/);
  assert.match(rec.ops_notes ?? "", /Available at the bar only\. Walk-ins welcome\./);
  assert.match(rec.ops_notes ?? "", /Cocchi di Tornio/);
  assert.match(rec.ops_notes ?? "", /Tiny Tini's/);
  assert.match(rec.ops_notes ?? "", /2\.5 oz/);
  assert.match(rec.ops_notes ?? "", /Tasting Tuesdays/);
  assert.match(rec.ops_notes ?? "", /Power Lunch/);
  assert.match(rec.ops_notes ?? "", /Soulful Brunch/);
  assert.match(rec.ops_notes ?? "", /Live in the Lounge/);
  assert.match(rec.ops_notes ?? "", /Whiskey Workshop/);
  assert.match(rec.ops_notes ?? "", /notes_public omitted/);
  assert.ok(
    !rec.deals.some((d) =>
      d.items.some((i) => /Power Lunch|Soulful Brunch|Live in the Lounge|Whiskey Workshop/i.test(i.text)),
    ),
    "Power Lunch / Soulful Brunch / Live in the Lounge / Whiskey Workshop stay off",
  );
  assert.ok(
    !rec.deals.some((d) => d.end === 1320 && d.happy_hour === true),
    "do not copy dinner-close or lounge 11pm onto the Martini Hour clock",
  );
  assert.ok(
    !rec.deals.some((d) => d.end === 1380 || d.end === 1440 || d.end === 60),
    "do not copy lounge 11pm onto a deal clock",
  );

  const hh = rec.deals.find((d) => d.happy_hour === true);
  const tasting = rec.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "tue");
  assert.ok(hh && tasting, "expected Martini Hour HH + Tasting Tuesdays");

  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 1020);
  assert.equal(hh.end, 1140);
  assert.equal(hh.time_window, "5pm-7pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Tiny Tini's 2.5 oz. Dirty Vodka Martini", "$8"],
      ["Classic Gin Martini", "$8"],
      ["Vesper", "$8"],
      ["Negroni", "$8"],
      ["Girl Dinner — Half Sweet Gem Caesar, French Fries, Choice of Full Sized Martini", "$28"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink", "small-plate/apps"]);

  assert.deepEqual(tasting.days, ["tue"]);
  assert.equal(tasting.start, 1020);
  assert.equal(tasting.end, 1320);
  assert.equal(tasting.time_window, "5pm-10pm");
  assert.deepEqual(
    tasting.items.map((i) => [i.text, i.price ?? null]),
    [["half-priced bottles", "1/2 price"]],
  );
  assert.deepEqual(tasting.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "rec-pier-chop-house"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "rec-pier-chop-house"));
});

test("Pink Flamingo joins 2026-08-21 (Remington citywide; do not fold into hampden)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const pf = byId["pink-flamingo"];
  assert.ok(pf, "pink-flamingo missing");
  assert.deepEqual(venueShapeErrors(pf), []);
  assert.equal(pf.name, "Pink Flamingo");
  assert.equal(pf.neighborhood, "Remington");
  assert.equal(
    pf.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(pf.status, "verified");
  assert.equal(pf.address, "300 W 30th St, Baltimore, MD 21211");
  assert.equal(pf.phone, "(443) 449-5854");
  assert.equal(pf.source_url, "https://pinkflamingobaltimore.com/menu/");
  assert.equal(pf.source_type, "venue_website");
  assert.equal(pf.last_verified, "2026-08-21");
  assert.equal(pf.notes_public, undefined);
  assert.equal(pf.deal_format, undefined);
  assert.equal(pf.lat, 39.3231862);
  assert.equal(pf.lon, -76.623155);
  assert.equal(pf.deals.length, 3);
  assert.match(pf.ops_notes ?? "", /Name=Remington/);
  assert.match(pf.ops_notes ?? "", /add Remington to citywideOnly/i);
  assert.match(pf.ops_notes ?? "", /Do not invent a \/remington/);
  assert.match(pf.ops_notes ?? "", /Do not fold into \/hampden/);
  assert.match(pf.ops_notes ?? "", /HappyHour2\.pdf/);
  assert.match(pf.ops_notes ?? "", /M-W\.Deals_-2\.pdf/);
  assert.match(pf.ops_notes ?? "", /CreationDate 2026-07-23/);
  assert.match(pf.ops_notes ?? "", /CreationDate 2026-05-08/);
  assert.match(pf.ops_notes ?? "", /4pm-10pm/);
  assert.match(pf.ops_notes ?? "", /11am-3pm/);
  assert.match(pf.ops_notes ?? "", /10:30pm/);
  assert.match(pf.ops_notes ?? "", /11:30pm/);
  assert.match(pf.ops_notes ?? "", /Mon\. – Fri\. 4-6pm/);
  assert.match(pf.ops_notes ?? "", /Do not copy 10pm or last call/);
  assert.match(pf.ops_notes ?? "", /Old Oriole Park Bohemian Lager/);
  assert.match(pf.ops_notes ?? "", /Do not write Natty Boh/);
  assert.match(pf.ops_notes ?? "", /R\.HOUSE/);
  assert.match(pf.ops_notes ?? "", /301 29th/);
  assert.match(pf.ops_notes ?? "", /PF-Menu-6-10\.pdf/);
  assert.match(pf.ops_notes ?? "", /Brunch-Menu-6-20-26\.pdf/);
  assert.match(pf.ops_notes ?? "", /Spirits-List-6\.24\.26\.pdf/);
  assert.match(pf.ops_notes ?? "", /Monday and Wednesday have both/);
  assert.ok(
    !pf.deals.some((d) => d.items.some((i) => /Natty Boh/i.test(i.text))),
    "do not write Natty Boh — Old Oriole Park Bohemian is Peabody Heights",
  );
  assert.ok(
    !pf.deals.some((d) => d.time_window === "all day"),
    "do not write time_window all day — All Day on this door is 4pm-close from dinner open",
  );
  assert.ok(
    !pf.deals.some((d) => d.end === 1320 || d.end === 1350 || d.end === 1410),
    "do not copy dinner-close 10pm or last call 10:30pm / 11:30pm onto a deal clock",
  );
  assert.ok(
    !pf.deals.some((d) => d.end === 1140 && d.happy_hour === true),
    "HH end is 1080 (6pm), not 1140",
  );
  assert.ok(
    !/R\.HOUSE|r\.house/i.test(JSON.stringify(pf.deals)),
    "do not mix R.HOUSE",
  );

  const hh = pf.deals.find((d) => d.happy_hour === true);
  const mon = pf.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "mon");
  const wed = pf.deals.find((d) => d.happy_hour === undefined && d.days.length === 1 && d.days[0] === "wed");
  assert.ok(hh && mon && wed, "expected Mon–Fri HH + Monday 4pm-close + Wednesday 4pm-close");

  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "4pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Featured Cocktail", "$8"],
      ["Happy Daiquiri", "$8"],
      ["The Local (Old Oriole Park Bohemian Lager + Lyon Rum shot)", "$8"],
      ["$2 off all draft pints", "$2 off"],
      ["$2 off all glasses of wine", "$2 off"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink"]);

  assert.deepEqual(mon.days, ["mon"]);
  assert.equal(mon.start, 960);
  assert.equal(mon.end, null);
  assert.equal(mon.time_window, "4pm-close");
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Wing Night", "$10"],
      ["Mai Tai", "$9"],
    ],
  );
  assert.deepEqual(mon.food_categories, ["wings", "drink"]);

  assert.deepEqual(wed.days, ["wed"]);
  assert.equal(wed.start, 960);
  assert.equal(wed.end, null);
  assert.equal(wed.time_window, "4pm-close");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["$4 off All Burgers with Fries", "$4 off"]],
  );
  assert.deepEqual(wed.food_categories, ["burger"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "pink-flamingo"));
  assert.ok(
    !venuesInView(venues, bySlug.hampden).some((v) => v.id === "pink-flamingo"),
    "Pink Flamingo must not fold into /hampden",
  );
  assert.equal(bySlug.remington, undefined, "do not invent a remington view");
});

test("Pitango Bakery joins 2026-08-21 (Fells Point / fells-point, Spritz Fridays + Bottles & Boards)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const pit = byId["pitango-bakery"];
  assert.ok(pit, "pitango-bakery missing");
  assert.deepEqual(venueShapeErrors(pit), []);
  assert.equal(pit.name, "Pitango Bakery");
  assert.equal(pit.neighborhood, "Fells Point");
  assert.equal(
    pit.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(pit.status, "verified");
  assert.equal(pit.address, "903 S Ann Street, Baltimore, MD 21231");
  assert.equal(pit.phone, "(443) 676-6447");
  assert.equal(pit.source_url, "https://www.pitangogelato.com/events");
  assert.equal(pit.source_type, "venue_website");
  assert.equal(pit.last_verified, "2026-08-21");
  assert.equal(pit.notes_public, undefined);
  assert.equal(pit.deal_format, undefined);
  assert.equal(pit.lat, 39.2815455);
  assert.equal(pit.lon, -76.5909807);
  assert.equal(pit.deals.length, 2);
  assert.match(pit.ops_notes ?? "", /Name=Fells Point/);
  assert.match(pit.ops_notes ?? "", /Already in \/fells-point/);
  assert.match(pit.ops_notes ?? "", /Do not add Fells Point to citywideOnly/);
  assert.match(pit.ops_notes ?? "", /pitangogelato\.com\/pitango-bakery/);
  assert.match(pit.ops_notes ?? "", /7 am - 9 pm/);
  assert.match(pit.ops_notes ?? "", /7am - 10pm/);
  assert.match(pit.ops_notes ?? "", /Do not copy 9pm \/ 10pm/);
  assert.match(pit.ops_notes ?? "", /Every Friday/);
  assert.match(pit.ops_notes ?? "", /every Wednesday/);
  assert.match(pit.ops_notes ?? "", /Fri Jul 18, 2025/);
  assert.match(pit.ops_notes ?? "", /Fri Apr 9, 2027/);
  assert.match(pit.ops_notes ?? "", /Tue Aug 5, 2025/);
  assert.match(pit.ops_notes ?? "", /Wed Mar 31, 2027/);
  assert.match(pit.ops_notes ?? "", /6:00 PM/);
  assert.match(pit.ops_notes ?? "", /end 1200, not 1080/);
  assert.match(pit.ops_notes ?? "", /802 S Broadway/);
  assert.match(pit.ops_notes ?? "", /\(410\) 236-0741/);
  assert.match(pit.ops_notes ?? "", /fells-point-gelato/);
  assert.match(pit.ops_notes ?? "", /Adams Morgan/);
  assert.match(pit.ops_notes ?? "", /Locally Sourced Comedy/);
  assert.match(pit.ops_notes ?? "", /omit recurrence/);
  assert.match(pit.ops_notes ?? "", /notes_public omitted/);
  assert.ok(
    !pit.deals.some((d) => d.recurrence),
    "weekly Every Friday / every Wednesday — omit recurrence",
  );
  assert.ok(
    !pit.deals.some((d) => d.happy_hour !== undefined),
    "happy_hour omit",
  );
  assert.ok(
    !pit.deals.some((d) => d.end === 1080),
    "do not copy Squarespace ICS 6:00 PM onto Friday end",
  );
  assert.ok(
    !pit.deals.some((d) => d.end === 1260 || d.end === 1320),
    "do not copy bakery close 9pm / 10pm onto a deal clock",
  );
  assert.ok(
    !pit.deals.some((d) => d.items.some((i) => /comedy|Locally Sourced/i.test(i.text))),
    "Locally Sourced Comedy stays off",
  );
  assert.ok(
    !/802 S Broadway|fells-point-gelato/i.test(JSON.stringify(pit.deals)),
    "do not mix Fells Point Gelato",
  );

  const fri = pit.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  const wed = pit.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  assert.ok(fri && wed, "expected Friday spritz + Wednesday bottles");

  assert.deepEqual(fri.days, ["fri"]);
  assert.equal(fri.start, 1020);
  assert.equal(fri.end, 1200);
  assert.equal(fri.time_window, "5pm-8pm");
  assert.deepEqual(
    fri.items.map((i) => [i.text, i.price ?? null]),
    [
      [
        "$1 off seasonal spritzes with a complimentary small bowl of chips— Italian Aperitivo style",
        "$1 off",
      ],
    ],
  );
  assert.deepEqual(fri.food_categories, ["drink"]);

  assert.deepEqual(wed.days, ["wed"]);
  assert.equal(wed.start, 1020);
  assert.equal(wed.end, 1230);
  assert.equal(wed.time_window, "5pm-8:30pm");
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price ?? null]),
    [["50% off all wine bottles with a purchase of a charcuterie board", "50% off"]],
  );
  assert.deepEqual(wed.food_categories, ["drink"]);

  assert.ok(venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "pitango-bakery"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "pitango-bakery"));
});

test("Estiatorio Plaka joins 2026-08-21 (Greektown citywide; do not fold into canton/fells-point)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const plaka = byId["estiatorio-plaka"];
  assert.ok(plaka, "estiatorio-plaka missing");
  assert.deepEqual(venueShapeErrors(plaka), []);
  assert.equal(plaka.name, "Estiatorio Plaka");
  assert.equal(plaka.neighborhood, "Greektown");
  assert.equal(
    plaka.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(plaka.status, "verified");
  assert.equal(plaka.address, "4718 Eastern Ave, Baltimore, MD 21224");
  assert.equal(plaka.phone, "(443) 833-0330");
  assert.equal(plaka.source_url, "https://www.estiatorioplaka.com/menu?menu=happy-hour");
  assert.equal(plaka.source_type, "venue_website");
  assert.equal(plaka.last_verified, "2026-08-21");
  assert.equal(plaka.notes_public, "bar only");
  assert.equal(plaka.deal_format, undefined);
  assert.equal(plaka.lat, 39.28732);
  assert.equal(plaka.lon, -76.555983);
  assert.equal(plaka.deals.length, 1);
  assert.match(plaka.ops_notes ?? "", /Name=Greektown/);
  assert.match(plaka.ops_notes ?? "", /add Greektown to citywideOnly/i);
  assert.match(plaka.ops_notes ?? "", /Do not invent a \/greektown/);
  assert.match(plaka.ops_notes ?? "", /Do not fold into \/canton/);
  assert.match(plaka.ops_notes ?? "", /Do not fold into \/fells-point/);
  assert.match(plaka.ops_notes ?? "", /Homepage does not print Greektown/);
  assert.match(plaka.ops_notes ?? "", /info@estiatorioplaka\.com/);
  assert.match(plaka.ops_notes ?? "", /Plaka Tavern/);
  assert.match(plaka.ops_notes ?? "", /estiatorioplaka\.com\/hours-location/);
  assert.match(plaka.ops_notes ?? "", /no clock of its own/);
  assert.match(plaka.ops_notes ?? "", /Tuesday–Friday \| 3–6 PM \(bar only\)/);
  assert.match(plaka.ops_notes ?? "", /shorter monitor leash/);
  assert.match(plaka.ops_notes ?? "", /11:00 am – 9:00 pm/);
  assert.match(plaka.ops_notes ?? "", /11:00 am – 10:00 pm/);
  assert.match(plaka.ops_notes ?? "", /Bakery opens 9am/);
  assert.match(plaka.ops_notes ?? "", /Do not copy 9pm \/ 10pm/);
  assert.match(plaka.ops_notes ?? "", /81f56d_72feb268f3b145a58efa39ad40584357\.pdf/);
  assert.match(plaka.ops_notes ?? "", /CreationDate 2026-04-17/);
  assert.match(plaka.ops_notes ?? "", /81f56d_fffe57ae9b3c4c07b5dfbc96da662968\.pdf/);
  assert.match(plaka.ops_notes ?? "", /CreationDate 2024-02-25/);
  assert.match(plaka.ops_notes ?? "", /Do not invent a second row from the IG emoji price list/);
  assert.match(plaka.ops_notes ?? "", /notes_public is required/);
  assert.ok(
    !plaka.deals.some((d) => d.end === 1260 || d.end === 1320),
    "do not copy restaurant close 9pm / 10pm or bakery 9pm onto a deal clock",
  );
  assert.ok(
    !plaka.deals.some((d) => d.items.some((i) => /lunch|dinner|brunch|winelist|beerlist/i.test(i.text))),
    "lunch / dinner / brunch / winelist / beerlist stay off",
  );
  assert.ok(
    !/81f56d_72feb268|81f56d_fffe57ae/i.test(JSON.stringify(plaka.deals)),
    "dated daily-specials PDF and older graphic PDF stay off deal rows",
  );

  const hh = plaka.deals.find((d) => d.happy_hour === true);
  assert.ok(hh, "expected one happy_hour row");
  assert.deepEqual(hh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price ?? null]),
    [
      ["Dollar Oysters", "$1"],
      ["Mini Gyros (2) with fries", "$11"],
      ["Classic Greek Salad", "$10"],
      ["Plaka Mezze Spreads", "$10"],
      ["Mini Chicken Skewer (2)", "$8"],
      ["Mini Pork Skewer (2)", "$8"],
      ["Wings 6PCS Spicy, Bbq, or Greek Style", "$10"],
      ["Zucchini Chips", "$10"],
      ["Mini Spinach & Cheese Pie", "$10"],
      ["Baked Feta Phyllo", "$10"],
      ["Fish Tacos", "$12"],
      ["Espresso Martinis", "$7"],
      ["All Draft Beers", "$3"],
      ["Wines by the Glass", "$6"],
      ["Bottle Beers", "$2"],
    ],
  );
  assert.deepEqual(hh.food_categories, [
    "seafood/crab",
    "small-plate/apps",
    "wings",
    "tacos",
    "drink",
  ]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "estiatorio-plaka"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "estiatorio-plaka"),
    "Estiatorio Plaka must not fold into /canton",
  );
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "estiatorio-plaka"),
    "Estiatorio Plaka must not fold into /fells-point",
  );
  assert.equal(bySlug.greektown, undefined, "do not invent a greektown view");
});

test("Raffy's on 36th joins 2026-08-21 (Hampden / hampden, Thursday date night)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const raffy = byId["raffys-on-36th"];
  assert.ok(raffy, "raffys-on-36th missing");
  assert.deepEqual(venueShapeErrors(raffy), []);
  assert.equal(raffy.name, "Raffy's on 36th");
  assert.equal(raffy.neighborhood, "Hampden");
  assert.equal(
    raffy.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-21",
  );
  assert.equal(raffy.status, "verified");
  assert.equal(raffy.address, "1115 W. 36th Street, Baltimore, MD 21211");
  assert.equal(raffy.phone, "(443) 216-9445");
  assert.equal(raffy.source_url, "https://www.raffyson36th.com/specials-events");
  assert.equal(raffy.source_type, "venue_website");
  assert.equal(raffy.last_verified, "2026-08-21");
  assert.equal(raffy.notes_public, undefined);
  assert.equal(raffy.deal_format, undefined);
  assert.equal(raffy.lat, 39.3308259);
  assert.equal(raffy.lon, -76.6342993);
  assert.equal(raffy.deals.length, 1);
  assert.match(raffy.ops_notes ?? "", /Name=Hampden/);
  assert.match(raffy.ops_notes ?? "", /Already in \/hampden/);
  assert.match(raffy.ops_notes ?? "", /Do not add Hampden to citywideOnly/);
  assert.match(raffy.ops_notes ?? "", /events@raffyson36th\.com/);
  assert.match(raffy.ops_notes ?? "", /License leftover name is Raffy's/);
  assert.match(raffy.ops_notes ?? "", /https:\/\/www\.raffyson36th\.com\//);
  assert.match(raffy.ops_notes ?? "", /\/specials 404/);
  assert.match(raffy.ops_notes ?? "", /4:30PM-9PM/);
  assert.match(raffy.ops_notes ?? "", /4:30PM-9:30PM/);
  assert.match(raffy.ops_notes ?? "", /12PM-10PM/);
  assert.match(raffy.ops_notes ?? "", /4:30PM-10PM vs specials 12PM-10PM/);
  assert.match(raffy.ops_notes ?? "", /Tuesday-Friday from 4:30pm-6:30pm/);
  assert.match(raffy.ops_notes ?? "", /times only, no \$/);
  assert.match(raffy.ops_notes ?? "", /Toast/);
  assert.match(raffy.ops_notes ?? "", /Instagram/);
  assert.match(raffy.ops_notes ?? "", /990\/1290/);
  assert.match(raffy.ops_notes ?? "", /990\/1110/);
  assert.match(raffy.ops_notes ?? "", /1260/);
  assert.match(raffy.ops_notes ?? "", /1320/);
  assert.match(raffy.ops_notes ?? "", /notes_public omitted/);
  assert.match(raffy.ops_notes ?? "", /omit food_categories/);
  assert.match(raffy.ops_notes ?? "", /Gertrude's Thursday/);
  assert.ok(
    !raffy.deals.some((d) => d.happy_hour !== undefined),
    "happy_hour omit",
  );
  assert.ok(
    !raffy.deals.some((d) => d.recurrence),
    "omit recurrence",
  );
  assert.ok(
    !raffy.deals.some((d) => d.food_categories !== undefined),
    "prix-fixe assortment — omit food_categories",
  );
  assert.ok(
    !raffy.deals.some((d) => d.time_window !== undefined),
    "no clock of its own — omit time_window (do not write all day or all night)",
  );
  assert.ok(
    !raffy.deals.some((d) => d.start === 990 || d.end === 1290 || d.end === 1110 || d.end === 1260 || d.end === 1320),
    "do not copy Thursday hours 4:30PM-9:30PM, HH 4:30-6:30, Tuesday 9PM, or Friday 10PM onto a deal clock",
  );
  assert.ok(
    !raffy.deals.some((d) => d.items.some((i) => /vibe/i.test(i.text))),
    "do not copy vibe onto the card",
  );
  assert.ok(
    !raffy.deals.some((d) => d.items.some((i) => /happy hour|4:30pm-6:30pm/i.test(i.text))),
    "Tuesday–Friday HH 4:30–6:30 stays off",
  );

  const dateNight = raffy.deals[0];
  assert.deepEqual(dateNight.days, ["thu"]);
  assert.equal(dateNight.start, null);
  assert.equal(dateNight.end, null);
  assert.equal(dateNight.time_window, undefined);
  assert.equal(dateNight.happy_hour, undefined);
  assert.equal(dateNight.food_categories, undefined, "prix-fixe assortment — same class as Gertrude's Thursday / Indigma thaali");
  assert.equal(dateNight.recurrence, undefined);
  assert.deepEqual(
    dateNight.items.map((i) => [i.text, i.price ?? null]),
    [["Share a meal, a drink, and conversation for $45 for the two of you", "$45"]],
  );
  assert.match(dateNight.items[0].text, /for the two of you/);
  assert.ok(!raffy.deals.some((d) => d.time_window === "all day" || d.time_window === "all night"));

  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "raffys-on-36th"));
  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "raffys-on-36th"));
});

test("Of Love & Regret and L.P. Steamers join 2026-08-18", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const olar = byId["of-love-and-regret"];
  assert.ok(olar, "of-love-and-regret missing");
  assert.deepEqual(venueShapeErrors(olar), []);
  assert.equal(olar.name, "Of Love & Regret");
  assert.equal(olar.neighborhood, "Canton");
  assert.match(
    olar.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(olar.status, "verified");
  assert.equal(olar.address, "1028 S. Conkling St., Baltimore, MD 21224");
  assert.equal(olar.phone, "(410) 327-0760");
  assert.equal(olar.source_url, "https://www.olarbmore.com/");
  assert.equal(olar.source_type, "venue_website");
  assert.equal(olar.deal_format, "image");
  assert.equal(olar.last_verified, "2026-08-18");
  assert.equal(olar.notes_public, undefined);
  assert.equal(olar.deals.length, 1);
  const olarHh = olar.deals[0];
  assert.deepEqual(olarHh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(olarHh.start, 960);
  assert.equal(olarHh.end, 1110);
  assert.equal(olarHh.time_window, "4pm-6:30pm");
  assert.equal(olarHh.happy_hour, true);
  assert.deepEqual(
    olarHh.items.map((i) => [i.text, i.price]),
    [
      ["$5 Burgers", "$5"],
      ["$2 Oysters", "$2"],
    ],
  );
  assert.deepEqual(olarHh.food_categories, ["burger", "seafood/crab"]);
  assert.equal(olarHh.proof_quote, "Tuesday to Friday | 4 PM - 6:30 PM");
  assert.doesNotMatch(
    olar.deals.flatMap((d) => d.items.map((i) => i.text)).join(" | "),
    /brunch/i,
  );
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "of-love-and-regret"));

  const lps = byId["lp-steamers"];
  assert.ok(lps, "lp-steamers missing");
  assert.deepEqual(venueShapeErrors(lps), []);
  assert.equal(lps.name, "L.P. Steamers");
  assert.equal(lps.neighborhood, "Riverside");
  assert.match(
    lps.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(lps.status, "verified");
  assert.equal(lps.address, "1100 E Fort Ave, Baltimore, MD 21230");
  assert.equal(lps.phone, "(410) 576-9294");
  assert.equal(lps.source_url, "https://www.locustpointsteamers.com/");
  assert.equal(lps.source_type, "venue_website");
  assert.equal(lps.last_verified, "2026-08-18");
  assert.equal(lps.notes_public, undefined);
  assert.equal(lps.deals.length, 2);
  const lpsTue = lps.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const lpsWed = lps.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  assert.equal(lpsTue.start, null);
  assert.equal(lpsTue.end, null);
  assert.equal(lpsTue.time_window, undefined);
  assert.deepEqual(
    lpsTue.items.map((i) => [i.text, i.price]),
    [["$1 off raw or steamed oysters", "$1 off"]],
  );
  assert.deepEqual(lpsTue.food_categories, ["seafood/crab"]);
  assert.equal(
    lpsTue.proof_quote,
    "Tuesdays- We offer Fried Hard Crabs (recently featured on Travel Channel's Food Paradise) & $1 off raw or steamed oysters!",
  );
  assert.ok(
    !lps.deals.some((d) => d.items.some((i) => /fried hard crab/i.test(i.text))),
    "fried hard crabs have no dollar amount and must stay off the card",
  );
  assert.equal(lpsWed.start, null);
  assert.equal(lpsWed.end, null);
  assert.equal(lpsWed.time_window, undefined);
  assert.deepEqual(
    lpsWed.items.map((i) => [i.text, i.price]),
    [
      ["1/2 priced steamed shrimp", "1/2 off"],
      ["$2 Natty Boh Drafts", "$2"],
    ],
  );
  assert.deepEqual(lpsWed.food_categories, ["seafood/crab", "drink"]);
  assert.equal(
    lpsWed.proof_quote,
    "Wednesdays- 1/2 priced Steamed Shrimp & $2 Natty Boh Drafts",
  );
  assert.ok(venuesInView(venues, bySlug["locust-point"]).some((v) => v.id === "lp-steamers"));
});

test("Waterfront Hotel, The Chasseur, and Raw & Refined join 2026-08-18", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const wfh = byId["waterfront-hotel"];
  assert.ok(wfh, "waterfront-hotel missing");
  assert.deepEqual(venueShapeErrors(wfh), []);
  assert.equal(wfh.name, "Waterfront Hotel");
  assert.equal(wfh.neighborhood, "Fells Point");
  assert.match(
    wfh.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(wfh.status, "verified");
  assert.equal(wfh.address, "1710 Thames Street, Baltimore MD 21231");
  assert.equal(wfh.phone, "(410) 537-5055");
  assert.equal(wfh.source_url, "http://www.waterfronthotelfellspoint.com/");
  assert.equal(wfh.source_type, "venue_website");
  assert.equal(wfh.deal_format, "image");
  assert.equal(wfh.last_verified, "2026-08-18");
  assert.equal(wfh.notes_public, undefined);
  assert.equal(wfh.deals.length, 1);
  const wfhHh = wfh.deals[0];
  assert.deepEqual(wfhHh.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(wfhHh.start, 960);
  assert.equal(wfhHh.end, 1140);
  assert.equal(wfhHh.time_window, "4pm-7pm");
  assert.equal(wfhHh.happy_hour, true);
  assert.deepEqual(
    wfhHh.items.map((i) => [i.text, i.price]),
    [
      ["$10 Espresso Martini", "$10"],
      ["$8 Spicy Pineapple Marg", "$8"],
      ["$5 Drafts", "$5"],
      ["$6 Wine", "$6"],
    ],
  );
  assert.deepEqual(wfhHh.food_categories, ["drink"]);
  assert.equal(wfhHh.proof_quote, "TUESDAY – FRIDAY | 4 – 7 PM");
  assert.ok(
    !wfh.deals.some((d) => d.items.some((i) => /fuzz/i.test(i.text))),
    "Fuzzies Burgers footer has no weekly $ and must stay off the card",
  );
  assert.ok(venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "waterfront-hotel"));

  const ch = byId["the-chasseur"];
  assert.ok(ch, "the-chasseur missing");
  assert.deepEqual(venueShapeErrors(ch), []);
  assert.equal(ch.name, "The Chasseur");
  assert.equal(ch.neighborhood, "Canton");
  assert.match(
    ch.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(ch.status, "verified");
  assert.equal(ch.address, "3328 Foster Avenue, Baltimore, MD 21224");
  assert.equal(ch.phone, "(410) 327-6984");
  assert.equal(ch.source_url, "https://www.chasseurbaltimore.com/drink");
  assert.equal(ch.source_type, "venue_website");
  assert.equal(ch.last_verified, "2026-08-18");
  assert.equal(ch.notes_public, undefined);
  assert.equal(ch.deals.length, 1);
  const chHh = ch.deals[0];
  assert.deepEqual(chHh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(chHh.start, 960);
  assert.equal(chHh.end, 1200);
  assert.equal(chHh.time_window, "4pm-8pm");
  assert.equal(chHh.happy_hour, true);
  assert.deepEqual(
    chHh.items.map((i) => [i.text, i.price]),
    [
      [
        "$2 off Wine, Draft Beer, Cocktails, Crushes, and Whistle Pig Old Fashioned",
        "$2 off",
      ],
    ],
  );
  assert.deepEqual(chHh.food_categories, ["drink"]);
  assert.equal(
    chHh.proof_quote,
    "HAPPY HOUR 4-8, Monday- Friday, $2 off Wine, Draft Beer, Cocktails, Crushes, and Whistle Pig Old Fashioned.",
  );
  assert.ok(
    !ch.deals.some((d) => d.items.some((i) => /egg roll|ribeye/i.test(i.text))),
    "/eat-2 food list has no days and must stay off the card",
  );
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "the-chasseur"));

  const rr = byId["raw-and-refined"];
  assert.ok(rr, "raw-and-refined missing");
  assert.deepEqual(venueShapeErrors(rr), []);
  assert.equal(rr.name, "Raw & Refined");
  assert.equal(rr.neighborhood, "Canton");
  assert.match(
    rr.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(rr.status, "verified");
  assert.equal(rr.address, "2723 Lighthouse Pt. E, Baltimore, MD 21224");
  assert.equal(rr.phone, "(443) 282-3640");
  assert.equal(rr.source_url, "http://www.rawandrefinedbaltimore.com/");
  assert.equal(rr.source_type, "venue_website");
  assert.equal(rr.deal_format, "image");
  assert.equal(rr.last_verified, "2026-08-18");
  assert.equal(
    rr.notes_public,
    "Happy hour is only available on the restaurant side- not the pool deck",
  );
  assert.equal(rr.deals.length, 1);
  const rrHh = rr.deals[0];
  assert.deepEqual(rrHh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(rrHh.start, 900);
  assert.equal(rrHh.end, 1080);
  assert.equal(rrHh.time_window, "3pm-6pm");
  assert.equal(rrHh.happy_hour, true);
  assert.deepEqual(
    rrHh.items.map((i) => [i.text, i.price]),
    [
      ["½ off select appetizers", "1/2 off"],
      ["$6 Seltzers", "$6"],
      ["$6 Orange & Grapefruit Crushes", "$6"],
      ["$15 32oz Crush Buckets", "$15"],
      ["$8 Classic Mojitos", "$8"],
      ["$8 Aperol Spritz", "$8"],
    ],
  );
  assert.deepEqual(rrHh.food_categories, ["small-plate/apps", "drink"]);
  assert.equal(rrHh.proof_quote, "MONDAY-FRIDAY / 3-6PM");
  assert.ok(
    !rr.deals.some((d) => d.items.some((i) => /\$5 drafts|\$10 crush/i.test(i.text))),
    "stale homepage-feed prices must stay off the card",
  );
  assert.match(rr.ops_notes, /6am/);
  assert.match(rr.ops_notes, /contact-us/i);
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "raw-and-refined"));
});

test("Verde, The HappyJack Tavern, Pusser's Landing, and Tutti Gusti join 2026-08-18", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const verde = byId.verde;
  assert.ok(verde, "verde missing");
  assert.deepEqual(venueShapeErrors(verde), []);
  assert.equal(verde.name, "Verde");
  assert.equal(verde.neighborhood, "Canton");
  assert.match(
    verde.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(verde.status, "verified");
  assert.equal(verde.address, "641 S Montford Ave., Baltimore, MD 21224");
  assert.equal(verde.phone, "(410) 522-1000");
  assert.equal(verde.source_url, "https://www.instagram.com/verdepizza/");
  assert.equal(verde.source_type, "instagram_profile");
  assert.equal(verde.deal_format, "image");
  assert.equal(verde.last_verified, "2026-08-18");
  assert.equal(verde.notes_public, undefined);
  assert.equal(verde.deals.length, 2);
  const verdeMon = verde.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const verdeTue = verde.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  assert.equal(verdeMon.start, null);
  assert.equal(verdeMon.end, null);
  assert.equal(verdeMon.time_window, undefined);
  assert.deepEqual(
    verdeMon.items.map((i) => [i.text, i.price]),
    [["25% off all pizzas", "25% off"]],
  );
  assert.deepEqual(verdeMon.food_categories, ["pizza"]);
  assert.equal(verdeMon.proof_quote, "every Monday at @verdepizza is 25% off all pizza");
  assert.equal(verdeTue.start, null);
  assert.equal(verdeTue.end, null);
  assert.equal(verdeTue.time_window, undefined);
  assert.deepEqual(
    verdeTue.items.map((i) => [i.text, i.price]),
    [["50% off bottles of wine", "1/2 off"]],
  );
  assert.deepEqual(verdeTue.food_categories, ["drink"]);
  assert.equal(verdeTue.proof_quote, "Tuesdays are half-priced bottle night");
  assert.ok(
    !verde.deals.some((d) => d.items.some((i) => /vegan/i.test(i.text))),
    "Maryland Vegan Restaurant Week ended Aug 16 and must stay off the card",
  );
  assert.match(verde.ops_notes, /Mon-Th 5-9p/);
  assert.match(verde.ops_notes, /Linktree/);
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "verde"));

  const hj = byId["the-happyjack-tavern"];
  assert.ok(hj, "the-happyjack-tavern missing");
  assert.deepEqual(venueShapeErrors(hj), []);
  assert.equal(hj.name, "The HappyJack Tavern");
  assert.equal(hj.neighborhood, "Canton");
  assert.match(
    hj.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(hj.status, "verified");
  assert.equal(hj.address, "2822 Hudson St, Baltimore, MD 21224");
  assert.equal(hj.phone, "(443) 835-2843");
  assert.equal(hj.source_url, "https://www.happyjacktavern.com/happy-hour");
  assert.equal(hj.source_type, "venue_website");
  assert.equal(hj.last_verified, "2026-08-18");
  assert.equal(
    hj.notes_public,
    "Happy hour food and Tuesday/Wednesday daily specials are dine-in only",
  );
  assert.equal(hj.deals.length, 7);
  const hjFood = hj.deals.find((d) => d.proof_quote === "MON-THURS 4-6PM | DINE-IN ONLY");
  assert.deepEqual(hjFood.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(hjFood.start, 960);
  assert.equal(hjFood.end, 1080);
  assert.equal(hjFood.time_window, "4pm-6pm");
  assert.equal(hjFood.happy_hour, true);
  assert.deepEqual(
    hjFood.items.map((i) => [i.text, i.price]),
    [
      ["$8 Smash Burger", "$8"],
      ["$8 Veggie Burger", "$8"],
      ["$8 Grilled Chicken", "$8"],
      ["$8 Classic Grilled Cheese", "$8"],
    ],
  );
  assert.deepEqual(hjFood.food_categories, ["burger", "small-plate/apps"]);
  const hjDrinksWeek = hj.deals.find((d) => d.proof_quote === "MON-FRI 4-6PM");
  assert.deepEqual(hjDrinksWeek.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hjDrinksWeek.start, 960);
  assert.equal(hjDrinksWeek.end, 1080);
  assert.equal(hjDrinksWeek.time_window, "4pm-6pm");
  assert.deepEqual(
    hjDrinksWeek.items.map((i) => [i.text, i.price]),
    [
      ["$1 off select beer, wine & cocktails marked w/ an *", "$1 off"],
      ["$5 rail liquor drinks", "$5"],
    ],
  );
  const hjDrinksSun = hj.deals.find((d) => d.proof_quote === "SUN 12PM-11PM");
  assert.deepEqual(hjDrinksSun.days, ["sun"]);
  assert.equal(hjDrinksSun.start, 720);
  assert.equal(hjDrinksSun.end, 1380);
  assert.equal(hjDrinksSun.time_window, "12pm-11pm");
  assert.deepEqual(
    hjDrinksSun.items.map((i) => [i.text, i.price]),
    hjDrinksWeek.items.map((i) => [i.text, i.price]),
  );
  const hjMon = hj.deals.find((d) => d.proof_quote === "DAILY SPECIALS 4PM-CLOSE");
  assert.deepEqual(hjMon.days, ["mon"]);
  assert.equal(hjMon.start, 960);
  assert.equal(hjMon.end, null);
  assert.equal(hjMon.time_window, undefined);
  assert.deepEqual(
    hjMon.items.map((i) => [i.text, i.price]),
    [["$8 just another guava mango margs", "$8"]],
  );
  const hjTue = hj.deals.find((d) => d.proof_quote === "TUESDAY – DINE-IN ONLY");
  assert.deepEqual(hjTue.days, ["tue"]);
  assert.equal(hjTue.start, 960);
  assert.equal(hjTue.end, null);
  assert.deepEqual(
    hjTue.items.map((i) => [i.text, i.price]),
    [["$15 one pound of wings w/ choice of natty boh or rail liquor drink", "$15"]],
  );
  const hjWed = hj.deals.find((d) => d.proof_quote === "WEDNESDAY – DINE-IN ONLY");
  assert.deepEqual(hjWed.days, ["wed"]);
  assert.equal(hjWed.start, 960);
  assert.equal(hjWed.end, null);
  assert.deepEqual(
    hjWed.items.map((i) => [i.text, i.price]),
    [["$5 single smash burgers or classic grilled cheese", "$5"]],
  );
  const hjThu = hj.deals.find((d) => d.proof_quote === "THURDSDAY");
  assert.deepEqual(hjThu.days, ["thu"]);
  assert.equal(hjThu.start, 960);
  assert.equal(hjThu.end, null);
  assert.deepEqual(
    hjThu.items.map((i) => [i.text, i.price]),
    [["$8 all boh'tails", "$8"]],
  );
  assert.ok(
    !hj.deals.some((d) => d.days.includes("fri") && d.proof_quote && /DAILY|THURDSDAY|TUESDAY|WEDNESDAY|MONDAY/.test(d.proof_quote) && d.proof_quote !== "MON-FRI 4-6PM"),
    "no Fri/Sat daily special published — do not invent one",
  );
  assert.ok(
    !hj.deals.some((d) => d.days.includes("sat")),
    "no Saturday special published",
  );
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "the-happyjack-tavern"));

  const pl = byId["pussers-landing"];
  assert.ok(pl, "pussers-landing missing");
  assert.deepEqual(venueShapeErrors(pl), []);
  assert.equal(pl.name, "Pusser's Landing");
  assert.equal(pl.neighborhood, "Canton");
  assert.match(
    pl.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(pl.status, "verified");
  assert.equal(pl.address, "2780 Lighthouse Point E, Baltimore, MD 21224");
  assert.equal(pl.phone, "(443) 869-2067");
  assert.equal(pl.source_url, "https://pusserslanding.com/specials/happy-hour/");
  assert.equal(pl.source_type, "venue_website");
  assert.equal(pl.last_verified, "2026-08-18");
  assert.equal(pl.notes_public, undefined);
  assert.equal(pl.deals.length, 1);
  const plHh = pl.deals[0];
  assert.deepEqual(plHh.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(plHh.start, 900);
  assert.equal(plHh.end, 1080);
  assert.equal(plHh.time_window, "3pm-6pm");
  assert.equal(plHh.happy_hour, true);
  assert.deepEqual(
    plHh.items.map((i) => [i.text, i.price]),
    [
      ["1/2 off Pusser's Rum Painkillers", "1/2 off"],
      ["1/2 off Draft Beer", "1/2 off"],
      ["1/2 off House Wine", "1/2 off"],
      ["1/2 off Wings", "1/2 off"],
      ["1/2 off Nachos", "1/2 off"],
    ],
  );
  assert.deepEqual(plHh.food_categories, ["drink", "small-plate/apps"]);
  assert.equal(
    plHh.proof_quote,
    "Join us Monday - Thursday for half off Pusser's Rum Painkillers, Draft Beer, House Wine, Wings & Nachos.",
  );
  assert.ok(
    !pl.deals.some((d) => d.days.includes("fri")),
    "no Friday HH published",
  );
  assert.ok(
    !pl.deals.some((d) => d.items.some((i) => /trivia/i.test(i.text))),
    "Tuesday trivia has no $ and must stay off the card",
  );
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "pussers-landing"));

  const tg = byId["tutti-gusti"];
  assert.ok(tg, "tutti-gusti missing");
  assert.deepEqual(venueShapeErrors(tg), []);
  assert.equal(tg.name, "Tutti Gusti");
  assert.equal(tg.neighborhood, "Canton");
  assert.match(
    tg.neighborhood_source,
    /Baltimore City Neighborhood Statistical Areas.*2026-08-18/,
  );
  assert.equal(tg.status, "verified");
  assert.equal(tg.address, "3102 Fait Ave, Baltimore, MD 21224");
  assert.equal(tg.phone, "(410) 534-4040");
  assert.equal(tg.source_url, "https://www.tuttigusti.net/");
  assert.equal(tg.source_type, "venue_website");
  assert.equal(tg.last_verified, "2026-08-18");
  assert.equal(tg.notes_public, undefined);
  assert.equal(tg.deals.length, 1);
  const tgMon = tg.deals[0];
  assert.deepEqual(tgMon.days, ["mon"]);
  assert.equal(tgMon.start, null);
  assert.equal(tgMon.end, null);
  assert.equal(tgMon.time_window, undefined);
  assert.deepEqual(
    tgMon.items.map((i) => [i.text, i.price]),
    [["Same-size cheese pizza $3 with any pizza at regular menu price", "$3"]],
  );
  assert.deepEqual(tgMon.food_categories, ["pizza"]);
  assert.equal(
    tgMon.proof_quote,
    "Buy Any Pizza at Regular menu Price, Get Same Size Cheese Pizza for Only $3.00.",
  );
  assert.ok(
    !tg.deals.some((d) => d.items.some((i) => /10%|cash/i.test(i.text))),
    "customer-review 10% cash discount is not the venue and must stay off the card",
  );
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "tutti-gusti"));
});

test("Ambassador Dining Room joins 2026-08-18 (Tuscany-Canterbury, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const adr = byId["ambassador-dining-room"];
  assert.ok(adr, "ambassador-dining-room missing");
  assert.deepEqual(venueShapeErrors(adr), []);
  assert.equal(adr.name, "Ambassador Dining Room");
  assert.equal(adr.neighborhood, "Tuscany-Canterbury");
  assert.equal(
    adr.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(adr.status, "verified");
  assert.equal(adr.address, "3811 Canterbury Rd, Baltimore, MD 21218");
  assert.equal(adr.phone, "(410) 366-1484");
  assert.equal(adr.source_url, "https://ambassadordining.com/");
  assert.equal(adr.source_type, "venue_website");
  assert.equal(adr.last_verified, "2026-08-18");
  assert.equal(adr.notes_public, undefined);
  assert.equal(adr.lat, 39.3353246);
  assert.equal(adr.lon, -76.6198238);
  assert.equal(adr.deals.length, 3);
  assert.match(adr.ops_notes, /Tue - Sun: 11:00 AM to 10:00 PM/);
  assert.match(adr.ops_notes, /Mon: 5:00 PM to 10:00 PM/);

  const hh = adr.deals.find((d) => d.happy_hour === true);
  assert.ok(hh, "HH drinks row missing");
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(hh.start, 1020);
  assert.equal(hh.end, 1110);
  assert.equal(hh.time_window, "5pm-6:30pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price]),
    [
      ["$10.95 Cranberry Bourbon", "$10.95"],
      ["$10.95 Gin Tonica", "$10.95"],
      ["$10.95 Sea Breeze", "$10.95"],
      ["$10.95 Goan Margarita", "$10.95"],
      ["$10.95 Ginger Mojito", "$10.95"],
      ["$10.95 Gin Amarood", "$10.95"],
      ["$10.95 Maryland Orange Crush", "$10.95"],
      ["$10.95 Martini", "$10.95"],
      ["$4.50 Beer (Blue Moon, Corona Extra, Budweiser)", "$4.50"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink"]);
  assert.match(hh.proof_quote, /Happy Hour Specials/);
  assert.match(hh.proof_quote, /Mon - Thu/);
  assert.match(hh.proof_quote, /5:00 PM - 6:30 PM/);

  const lunch = adr.deals.find((d) => d.proof_quote === "Buffet $21.95 Tue - Fri");
  assert.ok(lunch, "lunch buffet row missing");
  assert.deepEqual(lunch.days, ["tue", "wed", "thu", "fri"]);
  assert.equal(lunch.start, 660);
  assert.equal(lunch.end, 870);
  assert.equal(lunch.time_window, "11am-2:30pm");
  assert.equal(lunch.happy_hour, undefined);
  assert.deepEqual(
    lunch.items.map((i) => [i.text, i.price]),
    [["$21.95 Lunch buffet", "$21.95"]],
  );
  assert.deepEqual(lunch.food_categories, ["pasta/comfort"]);

  const brunch = adr.deals.find((d) => d.proof_quote === "Brunch $29.95 Sat & Sun");
  assert.ok(brunch, "brunch row missing");
  assert.deepEqual(brunch.days, ["sat", "sun"]);
  assert.equal(brunch.start, 660);
  assert.equal(brunch.end, 870);
  assert.equal(brunch.time_window, "11am-2:30pm");
  assert.equal(brunch.happy_hour, undefined);
  assert.deepEqual(
    brunch.items.map((i) => [i.text, i.price ?? null]),
    [
      ["$29.95 Brunch", "$29.95"],
      ["Unlimited mimosas & soft drinks with Saturday & Sunday Brunch", null],
    ],
  );
  assert.deepEqual(brunch.food_categories, ["brunch", "drink"]);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "ambassador-dining-room"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "ambassador-dining-room"),
    "Tuscany-Canterbury must not fold into /canton",
  );
  assert.equal(bySlug["tuscany-canterbury"], undefined, "do not invent a neighborhood view");
});

test("Amicci's joins 2026-08-18 (Little Italy, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const amiccis = byId.amiccis;
  assert.ok(amiccis, "amiccis missing");
  assert.deepEqual(venueShapeErrors(amiccis), []);
  assert.equal(amiccis.name, "Amicci's");
  assert.equal(amiccis.neighborhood, "Little Italy");
  assert.equal(
    amiccis.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(amiccis.status, "verified");
  assert.equal(amiccis.address, "231 S High St, Baltimore, MD 21202");
  assert.equal(amiccis.phone, "(410) 528-1096");
  assert.equal(amiccis.source_url, "https://www.amiccis.com/daily-specials");
  assert.equal(amiccis.source_type, "venue_website");
  assert.equal(amiccis.last_verified, "2026-08-18");
  assert.equal(amiccis.notes_public, undefined);
  assert.equal(amiccis.lat, 39.2867222);
  assert.equal(amiccis.lon, -76.6018584);
  assert.equal(amiccis.deals.length, 2);
  assert.match(amiccis.ops_notes, /Monday — Thursday 11:00am — 9:00pm/);
  assert.match(amiccis.ops_notes, /Friday — Saturday 11:00am — 10:00pm/);
  assert.match(amiccis.ops_notes, /Sunday 11:00am — 9:00pm/);

  const hh = amiccis.deals.find((d) => d.happy_hour === true);
  assert.ok(hh, "HH drinks + apps row missing");
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 900);
  assert.equal(hh.end, 1080);
  assert.equal(hh.time_window, "3pm-6pm");
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price]),
    [
      ["$2 off beers, house wines, homemade sangria", "$2 off"],
      ["$2 off appetizers (excluding salads and grlic bread)", "$2 off"],
    ],
  );
  assert.deepEqual(hh.food_categories, ["drink"]);
  assert.match(hh.proof_quote, /Happy Hour!!/);
  assert.match(hh.proof_quote, /Monday - Friday/);
  assert.match(hh.proof_quote, /3pm to 6pm/);
  assert.match(hh.proof_quote, /\(excluding Holidays\)/);
  assert.match(hh.items[1].text, /grlic/);

  const carryout = amiccis.deals.find((d) => /3 Courses/.test(d.proof_quote));
  assert.ok(carryout, "carryout 3-course row missing");
  assert.deepEqual(carryout.days, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(carryout.start, null);
  assert.equal(carryout.end, null);
  assert.equal(carryout.time_window, undefined);
  assert.equal(carryout.happy_hour, undefined);
  assert.deepEqual(
    carryout.items.map((i) => [i.text, i.price]),
    [["$25 3 Courses (carryout only)", "$25"]],
  );
  assert.deepEqual(carryout.food_categories, ["pasta/comfort"]);
  assert.match(carryout.proof_quote, /EVERYDAY!!!/);
  assert.match(carryout.proof_quote, /3 Courses for \$25/);
  assert.match(carryout.proof_quote, /Carryout only/);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "amiccis"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "amiccis"),
    "Little Italy must not fold into /canton",
  );
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "amiccis"),
    "Little Italy must not fold into /fells-point",
  );
  assert.equal(bySlug["little-italy"], undefined, "do not invent a neighborhood view");
});

test("Angie's Seafood joins 2026-08-18 (Upper Fells Point, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const angies = byId["angies-seafood"];
  assert.ok(angies, "angies-seafood missing");
  assert.deepEqual(venueShapeErrors(angies), []);
  assert.equal(angies.name, "Angie's Seafood");
  assert.equal(angies.neighborhood, "Upper Fells Point");
  assert.equal(
    angies.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(angies.status, "verified");
  assert.equal(angies.address, "1727 E Pratt St, Baltimore, MD 21231");
  assert.equal(angies.phone, "(410) 342-0917");
  assert.equal(
    angies.source_url,
    "https://angiesseafood.com/wp-content/uploads/2025/12/Happy-Hour.pdf",
  );
  assert.equal(angies.source_type, "venue_website");
  assert.equal(angies.last_verified, "2026-08-18");
  assert.equal(angies.notes_public, undefined);
  assert.equal(angies.lat, 39.2893554);
  assert.equal(angies.lon, -76.5933716);
  assert.equal(angies.deals.length, 1);
  assert.match(angies.ops_notes, /Last-Modified 2025-12-16/);
  assert.match(angies.ops_notes, /\/menu still links/);
  assert.match(angies.ops_notes, /410-342-0917/);
  assert.match(angies.ops_notes, /Do not fold into \/fells-point/);

  const hh = angies.deals[0];
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu"]);
  assert.equal(hh.start, null);
  assert.equal(hh.end, null);
  assert.equal(hh.time_window, "all day");
  assert.deepEqual(hh.food_categories, ["seafood/crab"]);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price]),
    [
      ["Hot crab pretzel", "$18"],
      ["Mussels in garlic sauce", "$15"],
      ["Shrimp or fish tacos", "$15"],
      ["Salmon slider", "$18"],
      ["Shrimp & crab eggrolls", "$24"],
      ["Garlic shrimp potato skins", "$14"],
      ["Buffalo wings", "$12"],
      ["Steak sliders", "$18"],
      ["Mozzarella sticks", "$12"],
      ["Lamb chops", "$25"],
      ["Cocktail flights", "$15"],
      ["Angie's Relaxer", "$12"],
      ["Margarita", "$12"],
      ["Long Island", "$12"],
      ["Lemon Drop", "$12"],
      ["House shot", "$9"],
      ["Espolòn", "$12"],
      ["Jose Cuervo", "$12"],
      ["Beers (Bud Light, Coors Light, Blue Moon)", "$5"],
    ],
  );
  assert.match(hh.proof_quote, /Happy Hour Menu/);
  assert.match(hh.proof_quote, /MONDAY - THURSDAY/);
  assert.match(hh.proof_quote, /ALL DAY/);
  assert.match(hh.items.find((i) => i.text === "Espolòn").text, /Espolòn/);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "angies-seafood"));
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "angies-seafood"),
    "Upper Fells Point must not fold into /fells-point",
  );
  assert.equal(bySlug["upper-fells-point"], undefined, "do not invent a neighborhood view");
});

test("Animal Boy joins 2026-08-18 (Waltherson, citywide only)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const animal = byId["animal-boy"];
  assert.ok(animal, "animal-boy missing");
  assert.deepEqual(venueShapeErrors(animal), []);
  assert.equal(animal.name, "Animal Boy");
  assert.equal(animal.neighborhood, "Waltherson");
  assert.equal(
    animal.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(animal.status, "verified");
  assert.equal(animal.address, "4801 Harford Rd S2, Baltimore MD 21214");
  assert.equal(animal.phone, "(443) 869-6620");
  assert.equal(animal.source_url, "https://www.animalboybaltimore.com/");
  assert.equal(animal.source_type, "venue_website");
  assert.equal(animal.last_verified, "2026-08-18");
  assert.equal(animal.notes_public, undefined);
  assert.equal(animal.lat, 39.3447319);
  assert.equal(animal.lon, -76.5673653);
  assert.equal(animal.deals.length, 2);
  assert.match(animal.ops_notes, /happy\.jpg Last-Modified 2026-08-17/);
  assert.match(animal.ops_notes, /still links both flyers/);
  assert.match(animal.ops_notes, /443-869-6620/);
  assert.match(animal.ops_notes, /Visible #hours and JSON-LD openingHours disagree/);
  assert.match(animal.ops_notes, /Tuesday 11-4pm/);
  assert.match(animal.ops_notes, /Mo 12:00-20:00, Tu Closed, We Closed/);
  assert.match(animal.ops_notes, /Tuesday visible close is 4pm vs HH 4–6/);
  assert.match(animal.ops_notes, /Do not invent a neighborhood view/);

  const hh = animal.deals.find((d) => d.time_window === "4pm-6pm");
  assert.ok(hh, "HH 4–6 row missing");
  assert.equal(hh.happy_hour, true);
  assert.deepEqual(hh.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(hh.start, 960);
  assert.equal(hh.end, 1080);
  assert.deepEqual(hh.food_categories, ["drink"]);
  assert.deepEqual(
    hh.items.map((i) => [i.text, i.price]),
    [
      ["$1 off drafts", "$1 off"],
      ["$1 off wine", "$1 off"],
    ],
  );
  assert.match(hh.proof_quote, /ANIMAL BOY HAPPY HOUR/);
  assert.match(hh.proof_quote, /MONDAY - FRIDAY/);
  assert.match(hh.proof_quote, /4 PM - 6 PM/);
  assert.match(hh.proof_quote, /\$1 OFF DRAFTS/);
  assert.match(hh.proof_quote, /\$1 OFF WINE/);

  const unhappy = animal.deals.find((d) => d.time_window === "8pm-10pm");
  assert.ok(unhappy, "Unhappy Hour 8–10 row missing");
  assert.equal(unhappy.happy_hour, true);
  assert.deepEqual(unhappy.days, ["wed", "thu", "fri"]);
  assert.equal(unhappy.start, 1200);
  assert.equal(unhappy.end, 1320);
  assert.deepEqual(unhappy.food_categories, ["drink"]);
  assert.deepEqual(
    unhappy.items.map((i) => [i.text, i.price]),
    [
      ["$1 off select cans", "$1 off"],
      ["$10 beer shot combos", "$10"],
      ["$2 off snacks", "$2 off"],
    ],
  );
  assert.match(unhappy.proof_quote, /Unhappy Hour/);
  assert.match(unhappy.proof_quote, /WEDNESDAY - FRIDAY 8 PM - 10 PM/);
  assert.match(unhappy.proof_quote, /\$1 OFF SELECT CANS/);
  assert.match(unhappy.proof_quote, /\$10 BEER SHOT COMBOS/);
  assert.match(unhappy.proof_quote, /\$2 OFF SNACKS/);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "animal-boy"));
  assert.ok(
    !venuesInView(venues, bySlug.canton).some((v) => v.id === "animal-boy"),
    "Waltherson must not fold into /canton",
  );
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "animal-boy"),
    "Waltherson must not fold into /fells-point",
  );
  assert.equal(bySlug.waltherson, undefined, "do not invent a neighborhood view");
});

test("Baltimore Seafood joins 2026-08-18 (Canton daily specials, no clock)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bs = byId["baltimore-seafood"];
  assert.ok(bs, "baltimore-seafood missing");
  assert.deepEqual(venueShapeErrors(bs), []);
  assert.equal(bs.name, "Baltimore Seafood");
  assert.equal(bs.neighborhood, "Canton");
  assert.equal(
    bs.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(bs.status, "verified");
  assert.equal(bs.address, "2324 Boston St, Baltimore, MD 21224");
  assert.doesNotMatch(bs.address, /2324-32/);
  assert.equal(bs.phone, "(410) 624-5166");
  assert.equal(bs.source_url, "https://www.bmoreseafood.com/menu");
  assert.equal(bs.source_type, "venue_website");
  assert.equal(bs.last_verified, "2026-08-18");
  assert.equal(bs.deal_format, "image");
  assert.equal(bs.notes_public, undefined);
  assert.equal(bs.lat, 39.2827389);
  assert.equal(bs.lon, -76.5834654);
  assert.equal(bs.deals.length, 5);
  assert.match(bs.ops_notes, /DAILY SPECIALS \(2022\)\.png/);
  assert.match(bs.ops_notes, /410-624-5166/);
  assert.match(bs.ops_notes, /2324 Boston St, not the license range 2324-32/);
  assert.match(bs.ops_notes, /Happy Hour tab on \/menu is a heading only/);
  assert.match(bs.ops_notes, /Do not invent 3–7 from IG/);
  assert.match(bs.ops_notes, /do not set happy_hour true/);
  assert.match(bs.ops_notes, /Already in \/canton/);
  assert.match(bs.ops_notes, /Do not invent a neighborhood view/);

  const mon = bs.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = bs.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = bs.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  const thu = bs.deals.find((d) => d.days.length === 1 && d.days[0] === "thu");
  const weekend = bs.deals.find((d) => d.days.includes("sat") && d.days.includes("sun"));
  assert.ok(mon && tue && wed && thu && weekend, "expected five daily-special rows");
  assert.ok(!bs.deals.some((d) => d.days.includes("fri")), "no Friday row on the graphic");
  for (const row of [mon, tue, wed, thu, weekend]) {
    assert.equal(row.start, null);
    assert.equal(row.end, null);
    assert.equal(row.time_window, undefined);
    assert.equal(row.happy_hour, undefined);
    assert.deepEqual(row.food_categories, ["seafood/crab"]);
  }
  assert.deepEqual(
    mon.items.map((i) => [i.text, i.price]),
    [["1LB black mussels + 0.5LB shrimp head-on", "$24"]],
  );
  assert.match(mon.proof_quote, /MUSSEL MONDAY/);
  assert.match(mon.proof_quote, /1LB BLACK MUSSELS/);
  assert.match(mon.proof_quote, /0\.5LB SHRIMP HEAD-ON/);
  assert.match(mon.proof_quote, /\$24/);
  assert.deepEqual(
    tue.items.map((i) => [i.text, i.price]),
    [["1LB crawfish + 0.5LB shrimp head-on", "$24"]],
  );
  assert.match(tue.proof_quote, /CRAWFISH TUESDAY/);
  assert.match(tue.proof_quote, /1LB CRAWFISH/);
  assert.match(tue.proof_quote, /0\.5LB SHRIMP HEAD-ON/);
  assert.match(tue.proof_quote, /\$24/);
  assert.deepEqual(
    wed.items.map((i) => [i.text, i.price]),
    [["1LB head-off shrimp + 0.5LB snow crab legs", "$35"]],
  );
  assert.match(wed.proof_quote, /SHRIMP WEDNESDAY/);
  assert.match(wed.proof_quote, /1LB HEAD-OFF SHRIMP/);
  assert.match(wed.proof_quote, /0\.5LB SNOW CRAB LEGS/);
  assert.match(wed.proof_quote, /\$35/);
  assert.deepEqual(
    thu.items.map((i) => [i.text, i.price]),
    [["1LB snow crab legs + 0.5LB shrimp head-off", "$39"]],
  );
  assert.match(thu.proof_quote, /CRAB LEG THURSDAY/);
  assert.match(thu.proof_quote, /1LB SNOW CRAB LEGS/);
  assert.match(thu.proof_quote, /0\.5LB SHRIMP HEAD-OFF/);
  assert.match(thu.proof_quote, /\$39/);
  assert.deepEqual(weekend.days, ["sat", "sun"]);
  assert.deepEqual(
    weekend.items.map((i) => [i.text, i.price]),
    [["1LB head-off shrimp + 1LB crawfish + 0.5LB snow crab legs", "$49"]],
  );
  assert.match(weekend.proof_quote, /WEEKEND ROYALE/);
  assert.match(weekend.proof_quote, /1LB HEAD-OFF SHRIMP/);
  assert.match(weekend.proof_quote, /1LB CRAWFISH/);
  assert.match(weekend.proof_quote, /0\.5LB SNOW CRAB LEGS/);
  assert.match(weekend.proof_quote, /\$49/);

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "baltimore-seafood"));
  assert.ok(venuesInView(venues, bySlug.canton).some((v) => v.id === "baltimore-seafood"));
  assert.ok(
    !venuesInView(venues, bySlug["fells-point"]).some((v) => v.id === "baltimore-seafood"),
    "Canton must not fold into /fells-point",
  );
});

test("The Barn & Lodge at The Rotunda joins 2026-08-18 (Hampden)", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  const bl = byId["barn-and-lodge"];
  assert.ok(bl, "barn-and-lodge missing");
  assert.deepEqual(venueShapeErrors(bl), []);
  assert.equal(bl.name, "The Barn & Lodge at The Rotunda");
  assert.equal(bl.neighborhood, "Hampden");
  assert.equal(
    bl.neighborhood_source,
    "Baltimore City Neighborhood Statistical Areas (geodata.baltimorecity.gov), point-in-polygon, 2026-08-18",
  );
  assert.equal(bl.status, "verified");
  assert.equal(bl.address, "729 W 40th Street, Baltimore, MD 21211");
  assert.equal(bl.phone, "(667) 260-2049");
  assert.equal(bl.source_url, "https://www.barnandlodge.com/rotunda/menu/");
  assert.equal(bl.source_type, "venue_website");
  assert.equal(bl.last_verified, "2026-08-18");
  assert.equal(bl.lat, 39.3370599);
  assert.equal(bl.lon, -76.6306443);
  assert.equal(bl.deals.length, 4);
  assert.match(bl.ops_notes, /Name=Hampden/);
  assert.match(bl.ops_notes, /Roland Park -- not used/);
  assert.match(bl.ops_notes, /dine-in only/);
  assert.match(bl.ops_notes, /Prime Rib \$38/);
  assert.match(bl.ops_notes, /Already in \/hampden/);
  assert.match(bl.ops_notes, /Do not invent a Roland Park view/);

  const gathering = bl.deals.find((d) => d.happy_hour === true);
  const mon = bl.deals.find((d) => d.days.length === 1 && d.days[0] === "mon");
  const tue = bl.deals.find((d) => d.days.length === 1 && d.days[0] === "tue");
  const wed = bl.deals.find((d) => d.days.length === 1 && d.days[0] === "wed");
  assert.ok(gathering && mon && tue && wed, "expected Gathering Hour + three daily rows");

  assert.deepEqual(gathering.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(gathering.start, 900);
  assert.equal(gathering.end, 1080);
  assert.equal(gathering.time_window, "3pm-6pm");
  assert.deepEqual(gathering.food_categories, ["drink", "pizza"]);
  assert.ok(gathering.items.some((i) => i.text === "Half price artisan pizzas" && i.price === "half off"));
  assert.ok(gathering.items.some((i) => i.text === "$9 featured cocktails" && i.price === "$9"));
  assert.ok(gathering.items.some((i) => i.text === "$5 well drinks" && i.price === "$5"));
  assert.ok(gathering.items.some((i) => i.text === "$5 wines by the glass" && i.price === "$5"));
  assert.ok(gathering.items.some((i) => i.text === "$5 bottled beer" && i.price === "$5"));
  assert.match(gathering.proof_quote, /Monday – Friday 3pm – 6pm/);

  assert.equal(mon.start, null);
  assert.equal(mon.end, null);
  assert.equal(mon.time_window, "all day");
  assert.deepEqual(mon.food_categories, ["burger"]);
  assert.deepEqual(mon.items.map((i) => [i.text, i.price]), [["Half off Lodge Burger", "half off"]]);
  assert.match(mon.proof_quote, /Burger Night/);

  assert.equal(tue.time_window, "all day");
  assert.deepEqual(tue.food_categories, ["pizza"]);
  assert.deepEqual(tue.items.map((i) => [i.text, i.price]), [["Half off artisan pizzas", "half off"]]);
  assert.match(tue.proof_quote, /Half Price All Artisan Pizzas/);

  assert.equal(wed.time_window, "all day");
  assert.deepEqual(wed.food_categories, ["pasta/comfort"]);
  assert.deepEqual(wed.items.map((i) => [i.text, i.price]), [["Half off housemade pasta", "half off"]]);
  assert.match(wed.proof_quote, /Half Price Housemade Pasta Night/);

  assert.ok(!bl.deals.some((d) => /Prime Rib/.test(d.proof_quote ?? "")), "Thursday Prime Rib must not ship");

  assert.ok(venuesInView(venues, bySlug.baltimore).some((v) => v.id === "barn-and-lodge"));
  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "barn-and-lodge"));
});

test("AJ's, Nick's, Rusty Scupper CoS ship 2026-08-07", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));
  const fed = bySlug["federal-hill"];
  const locust = bySlug["locust-point"];

  // AJ's — Mon–Fri 5–7 + Sat 2–5; Monday ships (CoS reopened); festival caveat.
  const ajs = byId["ajs-on-hanover"];
  assert.equal(ajs.status, "verified");
  assert.equal(ajs.neighborhood, "South Baltimore");
  assert.equal(ajs.phone, "(410) 800-2657");
  assert.match(ajs.notes_public ?? "", /festival|stadium/i);
  assert.doesNotMatch(ajs.notes_public ?? "", /closed monday/i);
  assert.match(ajs.ops_notes ?? "", /ajsonhanover\.com\/drinks/);
  assert.equal(ajs.deals.length, 2);
  const ajsWeek = ajs.deals.find((d) => d.days.includes("mon"));
  const ajsSat = ajs.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.deepEqual(ajsWeek.days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(ajsWeek.start, 1020);
  assert.equal(ajsWeek.end, 1140);
  assert.equal(ajsSat.start, 840);
  assert.equal(ajsSat.end, 1020);
  for (const d of ajs.deals) {
    assert.equal(d.items.length, 7);
    assert.ok(d.items.some((i) => i.text === "$5 House Wines"));
    assert.ok(d.items.some((i) => i.text === "$9 Brussels"));
  }
  assert.ok(venuesInView(venues, fed).some((v) => v.id === "ajs-on-hanover"));

  // Nick's — Mon–Thu 3–6 bar only; Port Covington; locust-point view.
  const nicks = byId["nicks-fish-house"];
  assert.equal(nicks.status, "verified");
  assert.equal(nicks.neighborhood, "Port Covington");
  assert.equal(nicks.phone, "(410) 347-4123");
  assert.match(nicks.notes_public ?? "", /bar area only/i);
  assert.match(nicks.ops_notes ?? "", /source_document_date=2026-04-02/);
  assert.equal(nicks.deals.length, 1);
  assert.deepEqual(nicks.deals[0].days, ["mon", "tue", "wed", "thu"]);
  assert.equal(nicks.deals[0].start, 900);
  assert.equal(nicks.deals[0].end, 1080);
  assert.ok(nicks.deals[0].items.some((i) => /Raw Oysters \$1\.50/.test(i.text)));
  assert.ok(nicks.deals[0].items.some((i) => /Draft Beer \$5/.test(i.text)));
  assert.deepEqual(locust.neighborhoods, ["Locust Point", "Riverside", "Port Covington", "Baltimore Peninsula"]);
  assert.ok(venuesInView(venues, locust).some((v) => v.id === "nicks-fish-house"));
  assert.ok(venuesInView(venues, locust).some((v) => v.id === "copper-shark"));
  assert.ok(venuesInView(venues, locust).some((v) => v.id === "rye-street-tavern"));

  // Rusty Scupper — Mon–Fri 4–6; $ prices; holidays/special-events on card.
  const rusty = byId["rusty-scupper"];
  assert.equal(rusty.status, "verified");
  assert.equal(rusty.neighborhood, "Federal Hill");
  assert.equal(rusty.phone, "(410) 727-3678");
  assert.match(rusty.notes_public ?? "", /dine-in only/i);
  assert.match(rusty.notes_public ?? "", /holiday|special event/i);
  assert.match(rusty.ops_notes ?? "", /source_document_date=2026-06-05/);
  assert.equal(rusty.deals.length, 1);
  assert.deepEqual(rusty.deals[0].days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(rusty.deals[0].start, 960);
  assert.equal(rusty.deals[0].end, 1080);
  // PDF had bare numbers — board stores $ form, not hyphens.
  assert.ok(rusty.deals[0].items.some((i) => i.price === "$8" && /Martinis/.test(i.text)));
  assert.ok(rusty.deals[0].items.some((i) => i.price === "$4.50"));
  assert.ok(rusty.deals[0].items.every((i) => !/- \d/.test(i.text)));
  assert.ok(venuesInView(venues, fed).some((v) => v.id === "rusty-scupper"));
});

test("Mount Vernon batch 1: Owl Bar, Sugarvale, Unity CoS ship 2026-08-07", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));
  const mv = bySlug["mount-vernon"];
  assert.deepEqual(mv.neighborhoods, ["Mount Vernon", "Mid-Town Belvedere"]);

  // Owl Bar — Mid-Town Belvedere; Tue–Fri 4–7 + Sat 2–6; nine items.
  const owl = byId["owl-bar"];
  assert.equal(owl.status, "verified");
  assert.equal(owl.neighborhood, "Mid-Town Belvedere");
  assert.equal(owl.phone, "(410) 347-0888");
  assert.equal(owl.deals.length, 2);
  const owlWeek = owl.deals.find((d) => d.days.includes("tue") && d.days.length === 4);
  const owlSat = owl.deals.find((d) => d.days.length === 1 && d.days[0] === "sat");
  assert.equal(owlWeek.start, 960);
  assert.equal(owlWeek.end, 1140);
  assert.equal(owlSat.start, 840);
  assert.equal(owlSat.end, 1080);
  assert.equal(owlWeek.items.length, 9);
  assert.ok(owlWeek.items.some((i) => i.price === "$6.50" && /Sangria/i.test(i.text)));
  assert.ok(!owl.deals.some((d) => d.days.includes("mon") || d.days.includes("sun")));
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "owl-bar"));

  // Sugarvale — Tue–Sun 5–7; no Monday; no phone; Sunday all-night is note only.
  const sugar = byId.sugarvale;
  assert.equal(sugar.status, "verified");
  assert.equal(sugar.neighborhood, "Mount Vernon");
  assert.equal(sugar.phone, undefined);
  assert.match(sugar.notes_public ?? "", /Sunday.*all night/i);
  const sugarHh = sugar.deals.find((d) => d.happy_hour === true);
  assert.deepEqual(sugarHh.days, ["tue", "wed", "thu", "fri", "sat", "sun"]);
  assert.equal(sugarHh.start, 1020);
  assert.equal(sugarHh.end, 1140);
  assert.ok(!sugarHh.days.includes("mon"));
  assert.ok(sugarHh.items.some((i) => /\$10/.test(i.text) && /cocktail/i.test(i.text)));
  const sugarTue = sugar.deals.find((d) => d.days[0] === "tue" && d.items.some((i) => /SV Burger/i.test(i.text)));
  const sugarWed = sugar.deals.find((d) => d.days[0] === "wed" && d.items.some((i) => /wine glasses/i.test(i.text)));
  assert.ok(sugarTue);
  assert.ok(sugarWed);
  // Opens 5pm and calls these NIGHT — "all day" would imply noon walk-in (CoS 2026-08-07).
  assert.equal(sugarTue.time_window, "all night");
  assert.equal(sugarWed.time_window, "all night");
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "sugarvale"));

  // Unity — Mon–Fri 4–7 HH only; no daily-special deal rows; gratuity note.
  const unity = byId["unity-bar-restaurant"];
  assert.equal(unity.status, "verified");
  assert.equal(unity.neighborhood, "Mount Vernon");
  assert.equal(unity.phone, "(443) 759-4082");
  assert.match(unity.notes_public ?? "", /18% gratuity/i);
  assert.match(unity.notes_public ?? "", /Daily specials/i);
  assert.match(unity.ops_notes ?? "", /source_document_date=2025-12-17/);
  assert.equal(unity.deals.length, 1);
  assert.deepEqual(unity.deals[0].days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(unity.deals[0].start, 960);
  assert.equal(unity.deals[0].end, 1140);
  assert.ok(unity.deals[0].items.some((i) => i.price === "$3.50"));
  assert.ok(unity.deals[0].items.some((i) => /Wings \(6\) \$10/.test(i.text)));
  // Daily specials must not appear as deal items.
  const unityText = unity.deals.flatMap((d) => d.items).map((i) => i.text).join(" | ");
  assert.doesNotMatch(unityText, /Steak|Catfish|Burger and fries|prosecco|bottle of wine/i);
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "unity-bar-restaurant"));
});

test("Minato and Brass Tap CoS ship 2026-08-07", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const mv = Object.fromEntries(views.map((v) => [v.slug, v]))["mount-vernon"];

  // Minato — HTML source_url (not PDF); Mon–Sat 4–7; dine-in + gratuity note.
  const minato = byId["minato-sushi-bar"];
  assert.equal(minato.status, "verified");
  assert.equal(minato.neighborhood, "Mid-Town Belvedere");
  assert.equal(minato.phone, "(410) 332-0332");
  assert.equal(minato.source_url, "https://www.minatosushibar.com/happy-hour/");
  assert.match(minato.notes_public ?? "", /Dine-in only/i);
  assert.match(minato.notes_public ?? "", /20% gratuity/i);
  assert.match(minato.ops_notes ?? "", /403|plain fetch/i);
  assert.equal(minato.deals.length, 1);
  assert.deepEqual(minato.deals[0].days, ["mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.ok(!minato.deals[0].days.includes("sun"));
  assert.equal(minato.deals[0].start, 960);
  assert.equal(minato.deals[0].end, 1140);
  // Eight price tiers — not the full menu (CoS after Eric card-length feedback).
  assert.equal(minato.deals[0].items.length, 8);
  assert.ok(minato.deals[0].items.some((i) => /special maki.*\$12\.50/i.test(i.text)));
  assert.ok(minato.deals[0].items.some((i) => /\$8\.95/.test(i.text) && /Cocktail/i.test(i.text)));
  assert.ok(minato.deals[0].items.some((i) => /Small beers \$3\.95/i.test(i.text)));
  assert.ok(minato.deals[0].items.some((i) => /Apps.*\$5\.50/i.test(i.text)));
  assert.ok(minato.deals[0].items.some((i) => /Wine \$6\.75/i.test(i.text)));
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "minato-sushi-bar"));

  // Brass Tap — PDF prices; window Mon–Sat 2–7 from /baltimore in ops_notes; no late night; no drink name.
  const brass = byId["brass-tap-baltimore"];
  assert.equal(brass.status, "verified");
  assert.equal(brass.neighborhood, "Mid-Town Belvedere");
  assert.equal(brass.phone, "(888) 901-2337");
  assert.match(brass.source_url, /happyhour\/71\.pdf/);
  assert.match(brass.ops_notes ?? "", /brasstapbeerbar\.com\/baltimore/);
  assert.match(brass.ops_notes ?? "", /source_document_date=2026-05-30/);
  assert.match(brass.ops_notes ?? "", /Late Night|latehappyhour/i);
  assert.equal(brass.deals.length, 1);
  assert.deepEqual(brass.deals[0].days, ["mon", "tue", "wed", "thu", "fri", "sat"]);
  assert.equal(brass.deals[0].start, 840);
  assert.equal(brass.deals[0].end, 1140);
  // $5 tier: Golden Truth, Select Pints, House Wine (not Coconut — that is $4.50 shots).
  assert.ok(brass.deals[0].items.some((i) => /Golden Truth \$5/.test(i.text)));
  assert.ok(brass.deals[0].items.some((i) => /Select Pints \$5/.test(i.text)));
  assert.ok(brass.deals[0].items.some((i) => /House Wine \$5/.test(i.text)));
  // CoS PDF layout: Coconut Key Lime Pie is $4.50 SHOTS group (regular $6), not $5.
  assert.ok(brass.deals[0].items.some((i) => i.text === "Coconut Key Lime Pie $4.50" && i.price === "$4.50"));
  assert.ok(!brass.deals[0].items.some((i) => /Coconut Key Lime Pie \$5/.test(i.text)));
  // Drink of the Week tier only — not this week's cocktail name.
  assert.ok(brass.deals[0].items.some((i) => i.text === "Drink of the Week $7"));
  const brassText = brass.deals[0].items.map((i) => i.text).join(" | ");
  assert.doesNotMatch(brassText, /Blue Mermaid/i);
  assert.doesNotMatch(brassText, /Late Night|9pm|10pm/i);
  // $6 Shots is regular menu price, not HH.
  assert.doesNotMatch(brassText, /\$6 Shots/i);
  assert.ok(brass.deals[0].items.some((i) => /Cheeseburger & Fries \$9/.test(i.text)));
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "brass-tap-baltimore"));
});

test("Coral Wig, Magdalena, Bar Dalí CoS ship 2026-08-08", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const mv = Object.fromEntries(views.map((v) => [v.slug, v]))["mount-vernon"];
  assert.deepEqual(mv.neighborhoods, ["Mount Vernon", "Mid-Town Belvedere"]);

  // Coral Wig — Mount Vernon; Mon–Fri 5–7; no phone; Monday all-night in notes.
  const coral = byId["coral-wig"];
  assert.equal(coral.status, "verified");
  assert.equal(coral.neighborhood, "Mount Vernon");
  assert.equal(coral.phone, undefined);
  assert.match(coral.notes_public ?? "", /Monday.*all night/i);
  assert.equal(coral.deals.length, 1);
  assert.deepEqual(coral.deals[0].days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(coral.deals[0].start, 1020);
  assert.equal(coral.deals[0].end, 1140);
  assert.ok(coral.deals[0].items.some((i) => /Painkillers \$10/.test(i.text)));
  assert.ok(coral.deals[0].items.some((i) => /\$2 off.*Estate Martinis/i.test(i.text)));
  assert.ok(coral.deals[0].items.some((i) => /1\/2 price.*Sparkling/i.test(i.text)));
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "coral-wig"));

  // Magdalena — Mid-Town Belvedere; Tue–Fri 4:30–6:30; rotating cocktail tier only.
  const mag = byId.magdalena;
  assert.equal(mag.status, "verified");
  assert.equal(mag.neighborhood, "Mid-Town Belvedere");
  assert.equal(mag.phone, "(410) 514-0303");
  assert.equal(mag.address, "205 E Biddle St, Baltimore, MD 21202");
  assert.deepEqual(mag.deals[0].days, ["tue", "wed", "thu", "fri"]);
  assert.equal(mag.deals[0].start, 990);
  assert.equal(mag.deals[0].end, 1110);
  assert.ok(mag.deals[0].items.some((i) => /Vermu Spritz \$7/.test(i.text)));
  assert.ok(mag.deals[0].items.some((i) => /Weekly rotating cocktail special \$7/.test(i.text)));
  assert.ok(mag.deals[0].items.some((i) => /Good Time Pilsner.*\$5/.test(i.text)));
  const magText = mag.deals[0].items.map((i) => i.text).join(" | ");
  assert.doesNotMatch(magText, /Old Fashioned|Green Brier|Nelson/i);
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "magdalena"));

  // Bar Dalí — Mount Vernon; Mon–Thu 4–6; 20% off Care Bottles as one line; image PDF source.
  const dali = byId["bar-dali"];
  assert.equal(dali.status, "verified");
  assert.equal(dali.neighborhood, "Mount Vernon");
  assert.equal(dali.phone, undefined);
  assert.match(dali.source_url, /happy-hour-june-2026-bar-dali\.pdf/);
  assert.match(dali.ops_notes ?? "", /source_document_date=2026-06-30/);
  assert.match(dali.ops_notes ?? "", /no text layer|image PDF/i);
  assert.deepEqual(dali.deals[0].days, ["mon", "tue", "wed", "thu"]);
  assert.equal(dali.deals[0].start, 960);
  assert.equal(dali.deals[0].end, 1080);
  assert.ok(dali.deals[0].items.some((i) => /Mahou.*Natty Boh.*\$5/.test(i.text)));
  assert.ok(dali.deals[0].items.some((i) => i.text === "20% off Care Bottles $28"));
  assert.ok(dali.deals[0].items.some((i) => /Dawn & Stormy.*\$10/.test(i.text)));
  assert.ok(venuesInView(venues, mv).some((v) => v.id === "bar-dali"));
});


test("Monarque, Alma, Wicked Sisters, Bluebird CoS ship 2026-08-08 — board hits 50", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const byId = Object.fromEntries(venues.map((v) => [v.id, v]));
  const bySlug = Object.fromEntries(views.map((v) => [v.slug, v]));

  // station-north view for Charles North (Alma) — not folded into Mount Vernon.
  const sn = bySlug["station-north"];
  assert.deepEqual(sn.neighborhoods, ["Charles North"]);

  // Monarque — Harbor East; Tue–Sat 5–7; two $10 food rows CoS added via bounding boxes.
  const mon = byId.monarque;
  assert.equal(mon.status, "verified");
  assert.equal(mon.neighborhood, "Harbor East");
  assert.equal(mon.phone, "(443) 384-1480");
  assert.match(mon.source_url, /MonQHH-03132026\.pdf/);
  assert.match(mon.ops_notes ?? "", /source_document_date=2026-03-13/);
  assert.deepEqual(mon.deals[0].days, ["tue", "wed", "thu", "fri", "sat"]);
  assert.equal(mon.deals[0].start, 1020);
  assert.equal(mon.deals[0].end, 1140);
  assert.ok(mon.deals[0].items.some((i) => /Oysters \(3\) \$6/.test(i.text)));
  assert.ok(mon.deals[0].items.some((i) => /Oysters Rockefeller \(3\) \$10/.test(i.text)));
  assert.ok(mon.deals[0].items.some((i) => /Spinach & Artichoke Dip \$10/.test(i.text)));
  assert.ok(mon.deals[0].items.some((i) => /\$3 upcharge for cocktails/.test(i.text)));
  assert.ok(!mon.deals[0].items.some((i) => i.text === "$3 upcharge for cocktails"));
  assert.ok(venuesInView(venues, bySlug["inner-harbor"]).some((v) => v.id === "monarque"));

  // Alma — Charles North; Wed/Thu/Fri 5–7 bar only; Sunday own 5pm-close row (end null).
  const alma = byId["alma-cocina-latina"];
  assert.equal(alma.status, "verified");
  assert.equal(alma.neighborhood, "Charles North");
  assert.equal(alma.phone, "(667) 212-4273");
  assert.match(alma.notes_public ?? "", /bar only/i);
  assert.match(alma.notes_public ?? "", /Sunday.*all night/i);
  assert.equal(alma.deals.length, 2);
  assert.deepEqual(alma.deals[0].days, ["wed", "thu", "fri"]);
  assert.equal(alma.deals[0].start, 1020);
  assert.equal(alma.deals[0].end, 1140);
  assert.equal(alma.deals[0].time_window, "5pm-7pm (bar only)");
  assert.deepEqual(alma.deals[1].days, ["sun"]);
  assert.equal(alma.deals[1].start, 1020);
  assert.equal(alma.deals[1].end, null);
  assert.equal(alma.deals[1].time_window, "5pm-close (bar only)");
  assert.ok(!alma.deals[0].days.includes("mon") && !alma.deals[0].days.includes("tue"));
  assert.ok(!alma.deals[0].days.includes("sun"));
  assert.ok(alma.deals[0].items.some((i) => /Tequeños \$10/.test(i.text)));
  assert.ok(alma.deals[0].items.some((i) => /Classic Latin cocktails \$10/.test(i.text)));
  assert.ok(alma.deals[1].items.some((i) => /Tequeños \$10/.test(i.text)));
  assert.ok(venuesInView(venues, sn).some((v) => v.id === "alma-cocina-latina"));

  // Wicked Sisters — Hampden Mon–Fri 3–6; regular-price proof in ops_notes.
  const wicked = byId["wicked-sisters"];
  assert.equal(wicked.status, "verified");
  assert.equal(wicked.neighborhood, "Hampden");
  assert.equal(wicked.phone, "(410) 878-0884");
  assert.match(wicked.ops_notes ?? "", /Zadies Lager \$5/);
  assert.match(wicked.ops_notes ?? "", /Old Fashioned \$13/);
  assert.deepEqual(wicked.deals[0].days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(wicked.deals[0].start, 900);
  assert.equal(wicked.deals[0].end, 1080);
  assert.ok(wicked.deals[0].items.some((i) => /Zadies Lager \$3/.test(i.text)));
  assert.ok(wicked.deals[0].items.some((i) => /Wings \$10/.test(i.text)));
  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "wicked-sisters"));

  // Bluebird — Hampden Mon–Fri 5–6:30; cocktail tier + address; no pinned cocktail names on card.
  const bird = byId["the-bluebird"];
  assert.equal(bird.status, "verified");
  assert.equal(bird.neighborhood, "Hampden");
  assert.equal(bird.phone, undefined);
  assert.equal(bird.address, "3600 Hickory Avenue, Baltimore, MD 21211");
  assert.deepEqual(bird.deals[0].days, ["mon", "tue", "wed", "thu", "fri"]);
  assert.equal(bird.deals[0].start, 1020);
  assert.equal(bird.deals[0].end, 1110);
  assert.ok(bird.deals[0].items.some((i) => i.text === "Select classic cocktails $10"));
  assert.ok(bird.deals[0].items.some((i) => /Bluebird Cheeseburger \$13/.test(i.text)));
  const birdText = bird.deals[0].items.map((i) => i.text).join(" | ");
  assert.doesNotMatch(birdText, /Champagne Cocktail|Lemon Drop|Aviation/i);
  assert.match(bird.ops_notes ?? "", /Champagne Cocktail|Lemon Drop|Aviation/);
  assert.ok(venuesInView(venues, bySlug.hampden).some((v) => v.id === "the-bluebird"));
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

  // The Point shipped 2026-08-11 (times only, no prices). The 2026-08-06 hold
  // note is PRESERVED in ops_notes, not overwritten — it is the audit trail,
  // and the new note records why its Friday finding no longer holds.
  const point = venues.find((v) => v.id === "the-point-in-fells");
  assert.equal(point.deals.length, 2, "Mon/Wed/Thu 4-7pm plus Friday all day");
  assert.match(point.ops_notes ?? "", /CoS 2026-08-06 hold/i);
  assert.match(point.ops_notes ?? "", /no longer holds/i);
  assert.ok(!point.deals.some((d) => d.days.includes("tue")), "closed Tuesdays");
  const pointFri = point.deals.find((d) => d.days.length === 1 && d.days[0] === "fri");
  assert.equal(pointFri.start, null, "no clock invented from opening hours");
  assert.equal(pointFri.end, null);

  const thames = venues.find((v) => v.id === "thames-street-oyster-house");
  assert.equal(
    thames.source_url,
    "https://www.thamesstreetoysterhouse.com/happy-hour.htm",
  );
  for (const d of thames.deals.filter((x) => x.happy_hour)) {
    assert.equal(d.source_url, "https://www.thamesstreetoysterhouse.com/happy-hour.htm");
    assert.ok(d.items.some((i) => /\$2/.test(i.text) && /oyster/i.test(i.text)));
    assert.ok(!d.items.some((i) => /prices not published/i.test(i.text)));
    assert.ok(!d.items.some((i) => /\$\d/.test(i.text) && /cocktail|beer|wine/i.test(i.text)));
  }
});

// --- D-batch stability: verified_date coverage + banned-phrase guard ---

test("D-batch: every renderable deal row carries a verified_date", async () => {
  const venues = await loadVenues();
  const missing = [];
  for (const v of venues) {
    if (!isRenderable(v)) continue;
    for (const d of v.deals) {
      if (d.status === "held") continue;
      if (!d.verified_date) {
        missing.push(`${v.name} ${d.days.join(",")} ${d.items.map((i) => i.text.slice(0, 30)).join(" | ")}`);
      }
    }
  }
  assert.deepEqual(missing, [], `renderable rows missing verified_date: ${missing.length}`);
});

test("D-batch: public pages never leak internal process language", async () => {
  const banned = ["ship set", "Quiet group", "we can re-read", "we cannot read", "we cannot show"];
  const venues = await loadVenues();
  const views = await loadViews();
  const html = renderBoard(venuesInView(venues, views[0]), views[0], views, SAT_1AM_EDT);
  for (const phrase of banned) {
    assert.doesNotMatch(html, new RegExp(phrase, "i"), `banned phrase found in board HTML: "${phrase}"`);
  }
  // Also check raw notes_public on every venue — open_unverifiable venues
  // don't render on the board, but their notes_public appear on venue pages.
  for (const v of venues) {
    if (!v.notes_public) continue;
    for (const phrase of banned) {
      assert.doesNotMatch(v.notes_public, new RegExp(phrase, "i"),
        `banned phrase "${phrase}" in ${v.name} notes_public: "${v.notes_public}"`);
    }
  }
});

test("D-batch mutation: banned-phrase guard catches a regression", () => {
  // The guard must fail if a banned phrase re-enters — prove it.
  assert.throws(() => {
    assert.doesNotMatch("notes include ship set jargon", /ship set/i);
  });
});

// --- B3: external links open in a new tab ---

test("B3: board source links carry target=_blank rel=noopener", async () => {
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const html = renderBoard(venuesInView(await loadVenues(), canton), canton, views, SAT_1AM_EDT);
  // External source links carry target and rel.
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  // Internal venue links do NOT carry target.
  const venueLinks = [...html.matchAll(/class="venue-link" href="([^"]+)"/g)];
  for (const m of venueLinks) {
    assert.doesNotMatch(m[0], /target=/);
  }
  // Internal map/calendar links do NOT carry target.
  const mapLink = html.match(/href="[^"]*\/map"/);
  assert.ok(mapLink);
  assert.doesNotMatch(mapLink[0], /target=/);
});

test("B3: venue page source links carry target=_blank rel=noopener", async () => {
  const venues = await loadVenues();
  const hucks = venues.find((v) => v.id === "hucks-american-craft");
  const html = renderVenuePage(hucks, await loadViews(), SAT_1AM_EDT);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
  // Internal board/map links do NOT carry target.
  const internalLinks = [...html.matchAll(/href="\/(?!\/)[^"]*"/g)];
  for (const m of internalLinks) {
    assert.doesNotMatch(m[0], /target=/);
  }
});

test("B3: map popup source links carry target=_blank rel=noopener", async () => {
  const { popupHtml } = await import("../src/map.js");
  const venues = await loadVenues();
  // Find a venue with a source_url for a meaningful popup.
  const hucks = venues.find((v) => v.id === "hucks-american-craft");
  const entry = { id: hucks.id, name: hucks.name, neighborhood: hucks.neighborhood, phone: hucks.phone, source_url: hucks.source_url, last_verified: hucks.last_verified, deals: hucks.deals };
  const html = popupHtml(entry, SAT_1AM_EDT);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
});

// --- B4: phone formatting ---

test("B4: formatPhone normalises three input shapes to (XXX) XXX-XXXX", () => {
  assert.equal(formatPhone("(410) 727-1355"), "(410) 727-1355");
  assert.equal(formatPhone("443-602-7450"), "(443) 602-7450");
  assert.equal(formatPhone("410.276.3100"), "(410) 276-3100");
  // Already correct.
  assert.equal(formatPhone("(410) 555-1234"), "(410) 555-1234");
});

test("B4: non-10-digit numbers pass through unchanged", () => {
  assert.equal(formatPhone("+1-410-555-1234"), "+1-410-555-1234");
  assert.equal(formatPhone("555-1234"), "555-1234");
  assert.equal(formatPhone(""), "");
});

test("B4: board cards render formatted phone numbers", async () => {
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const html = renderBoard(venuesInView(await loadVenues(), canton), canton, views, SAT_1AM_EDT);
  // Should contain at least some formatted phone numbers.
  assert.match(html, /\(\d{3}\) \d{3}-\d{4}/);
  // Dots and dashes as formatting are gone from displayed phone text.
  // (Venues with 10-digit phones get the canonical format.)
});

test("B4: venue page renders formatted phone numbers", async () => {
  const venues = await loadVenues();
  const hucks = venues.find((v) => v.id === "hucks-american-craft");
  const html = renderVenuePage(hucks, await loadViews(), SAT_1AM_EDT);
  assert.match(html, /\(\d{3}\) \d{3}-\d{4}/);
});

// --- B5: multi-neighborhood note ---

test("B5: multi-neighborhood view renders an explanatory note", async () => {
  const views = await loadViews();
  // Canton includes Canton + Brewers Hill.
  const canton = views.find((v) => v.slug === "canton");
  const html = renderBoard(venuesInView(await loadVenues(), canton), canton, views, SAT_1AM_EDT);
  assert.match(html, /class="meta view-note"/);
  assert.match(html, /Includes Canton and Brewers Hill/);
});

test("B5: single-neighborhood view has no note", async () => {
  const views = await loadViews();
  // Fells Point has only Fells Point.
  const fells = views.find((v) => v.slug === "fells-point");
  const html = renderBoard(venuesInView(await loadVenues(), fells), fells, views, SAT_1AM_EDT);
  assert.doesNotMatch(html, /class="meta view-note"/);
});

test("B5: city-wide view (neighborhoods: *) has no multi-hood note", async () => {
  const views = await loadViews();
  const baltimore = views.find((v) => v.slug === "baltimore");
  const html = renderBoard(venuesInView(await loadVenues(), baltimore), baltimore, views, SAT_1AM_EDT);
  assert.doesNotMatch(html, /class="meta view-note"/);
});
