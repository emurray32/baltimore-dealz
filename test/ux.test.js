// UI/UX pass, 2026-09-24. Each test here pins one defect that was live on the
// board and is mutation-checked: reverting its fix turns the test red.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { venuesInView } from "../src/deals.js";
import { renderBoard } from "../src/page.js";
import { dealText } from "../src/month.js";
import { collapseSchedule, renderVenuePage, venueScheduleByDay } from "../src/venue.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";
import { loadEvents } from "../src/events.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = new Date("2026-09-24T20:00:00Z"); // Thursday evening, Baltimore

async function board() {
  const views = await loadViews();
  const view = views.find((v) => v.slug === "canton") ?? views[0];
  const venues = venuesInView(await loadVenues(), view);
  return renderBoard(venues, view, views, NOW);
}

test("no empty time-window pill renders on the board", async () => {
  const html = await board();
  // An empty <span class="window"> still draws a bordered box, so 91 venues
  // with no published time were showing a small blank pill where a time
  // should be. A window chip must always carry text.
  const empties = html.match(/<span class="window[^"]*"><\/span>/g) ?? [];
  assert.equal(empties.length, 0, `empty window chips: ${empties.length}`);
  // Control: the page really does render window chips, so a zero above is a
  // fixed defect and not an empty search.
  assert.ok(/<span class="window[^"]*">[^<]+<\/span>/.test(html), "board renders at least one window chip");
});

test("the sr-only filter count is contained by its button", async () => {
  // .filter-count is position:absolute. With no positioned ancestor it
  // resolves against the initial containing block, so counts on buttons
  // scrolled out of view landed past the viewport and widened the document
  // (390 -> 1559 on a phone; the desktop column drifted off-centre and the
  // neighbourhood row was cut off mid-word).
  const css = await readFile(join(ROOT, "public/style.css"), "utf8");
  const rule = css.match(/\.filter-btn\s*\{[^}]*\}/);
  assert.ok(rule, ".filter-btn rule exists");
  assert.match(rule[0], /position:\s*relative/, ".filter-btn must contain its absolute child");
  const count = css.match(/\.filter-count\s*\{[^}]*\}/);
  assert.ok(count && /position:\s*absolute/.test(count[0]), "control: .filter-count is still absolute");
});

test("no stylesheet rule overrides the responsive h1 size", async () => {
  // A `h1 { font-size: 2.8rem }` inside @media (max-width: 40rem) beat the
  // clamp and forced every board title onto two lines on a phone, costing
  // ~100px of the first screen.
  const css = await readFile(join(ROOT, "public/style.css"), "utf8");
  const narrow = css.match(/@media \(max-width: 40rem\) \{[\s\S]*?\n\}/);
  assert.ok(narrow, "narrow media block exists");
  assert.doesNotMatch(narrow[0], /\bh1\s*\{[^}]*font-size/, "h1 font-size must stay on the clamp");
  assert.match(css, /font-size:\s*clamp\([^)]*vw[^)]*\)/, "control: h1 still sizes from a vw clamp");
});

test("calendar day list never prints a price twice", () => {
  // The calendar read "$5 Draft Beers $5" because the price was appended even
  // when the offer text already carried it. Tested on dealText directly: the
  // rendered month page also contains venue copy that repeats its own price
  // ("... each $5"), which is the source's wording, not this bug.
  const alreadyPriced = dealText({ items: [{ text: "$5 Draft Beers", price: "$5" }] });
  assert.equal(alreadyPriced, "$5 Draft Beers");

  // Must-be-TRUE control through the same code path: when the text does not
  // carry the price, the price is still appended.
  const needsPrice = dealText({ items: [{ text: "Draft Beers", price: "$5" }] });
  assert.equal(needsPrice, "Draft Beers $5");
});

test("a venue's identical consecutive days collapse into one block", async () => {
  const venues = await loadVenues();
  // Exact identity only: two days share a block when the same deal rows drive
  // both. A daily happy hour was rendering seven identical cards.
  const everyDay = venues.find((v) => {
    const runs = collapseSchedule(venueScheduleByDay(v));
    return runs.length === 1 && runs[0].label === "Every day" && runs[0].deals.length > 0;
  });
  assert.ok(everyDay, "at least one venue runs the same deals all seven days");
  const runs = collapseSchedule(venueScheduleByDay(everyDay));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].keys, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

  const html = renderVenuePage(everyDay, { boardHref: "/canton", listLabel: "Back", now: NOW });
  const sections = html.match(/<section class="venue-day"/g) ?? [];
  assert.equal(sections.length, 1, "one day block, not seven");
  assert.match(html, /<h2>Every day<\/h2>/);

  // A venue whose days genuinely differ must NOT be merged.
  const mixed = venues.find((v) => {
    const sched = venueScheduleByDay(v);
    const runs2 = collapseSchedule(sched);
    return runs2.length > 1 && sched.some((d) => d.deals.length > 0);
  });
  assert.ok(mixed, "control: a venue with differing days stays split");
});

test("the board page carries the class its desktop layout is scoped to", async () => {
  const html = await board();
  assert.match(html, /<body class="board-page">/);
  const css = await readFile(join(ROOT, "public/style.css"), "utf8");
  assert.match(css, /body\.board-page[\s\S]{0,400}grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  // A bare `1fr` floors at min-content, and .lead is white-space:nowrap, so a
  // single long offer widened the document to 2921px on a 1280px screen.
  assert.doesNotMatch(css, /grid-template-columns:\s*1fr 1fr/);
});
