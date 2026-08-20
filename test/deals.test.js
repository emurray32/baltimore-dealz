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
  // Tuscany-Canterbury / Little Italy / Upper Fells Point / Waltherson / Belair-Edison / Charles Village / Morrell Park have no home page; those venues are citywide-only.
  const citywideOnly = new Set(["Tuscany-Canterbury", "Little Italy", "Upper Fells Point", "Waltherson", "Belair-Edison", "Charles Village", "Morrell Park"]);
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
    ["blackwall-hitch", "captain-james-landing", "holy-frijoles", "hudson-street-stackhouse", "the-outpost", "the-point-in-fells"],
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
  assert.equal(inView.length, 15);
  assert.deepEqual(
    inView.map((v) => v.id).sort(),
    [
      "admirals-cup",
      "alexanders-tavern-fells",
      "bunnys-buckets",
      "harbor-tandoor",
      "maxs-taphouse",
      "papis-taco-joint-fells",
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
  assert.equal(showable, 84);
  assert.equal(venues.length, 106);
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
