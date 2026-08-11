// Venue detail pages + card address de-clutter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isDealRenderable, venuesInView } from "../src/deals.js";
import { cardsHtmlForDay, escapeHtml, renderBoard } from "../src/page.js";
import {
  boardViewForVenue,
  renderVenuePage,
  venueScheduleByDay,
} from "../src/venue.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, loadViews } from "../src/views.js";
import { buildStatic } from "../scripts/build-static.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z");

test("deal cards omit street address; quiet venues keep it on their venue page", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const boardVenues = venuesInView(venues, canton);
  const html = renderBoard(boardVenues, canton, views, FRI_11PM_EDT);

  // A known Canton address must not appear on deal cards.
  const stack = venues.find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stack.address);
  const cards = cardsHtmlForDay(boardVenues, "fri", FRI_11PM_EDT);
  assert.doesNotMatch(cards, new RegExp(stack.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Neighbourhood, phone, source still present on cards.
  assert.match(cards, /Canton|Brewers Hill/);
  assert.match(cards, /venue-link/);
  assert.match(cards, /\/venue\//);

  // Quiet group is gone from the board (Eric rule). Street address still lives
  // on the venue page for a zero-deal venue — page kept, not deleted.
  assert.doesNotMatch(html, /class="quiet"/);
  const walt = venues.find((v) => v.id === "walts-inn");
  assert.ok(walt?.address);
  assert.ok(!html.includes(escapeHtml(walt.address)), "quiet street must not be on board");
  const waltPage = renderVenuePage(walt, views, FRI_11PM_EDT);
  assert.ok(
    waltPage.includes(escapeHtml(walt.address)),
    "quiet venue page must keep street address",
  );
});

test("venue page shows full weekly schedule; held deals and ops_notes never appear", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const claddagh = venues.find((v) => v.id === "claddagh-pub");
  assert.ok(claddagh);

  const html = renderVenuePage(claddagh, views, FRI_11PM_EDT, {
    boardHref: "/canton",
    listLabel: "Back to Canton",
  });

  assert.match(html, /Claddagh Pub/);
  assert.match(html, /Back to Canton/);
  // Address is on the detail page (removed from cards).
  assert.ok(html.includes(escapeHtml(claddagh.address)));
  // Weekly day headings
  assert.match(html, /Monday/);
  assert.match(html, /Friday/);
  assert.doesNotMatch(html, /ops_notes/);

  // Held-only text must not appear on that venue page. Was El Bufalo until
  // 2026-08-11; Good Vibes is the held example now. Its held row shares
  // "$7 Margaritas" with a renderable row, so subtract anything showable —
  // a shared line is not evidence of a leak.
  const bufalo = venues.find((v) => v.id === "good-vibes-cantina");
  const showableText = new Set(
    bufalo.deals.filter(isDealRenderable).flatMap((d) => d.items.map((i) => i.text)),
  );
  const heldOnly = bufalo.deals
    .filter((d) => !isDealRenderable(d))
    .flatMap((d) => d.items.map((i) => i.text))
    .filter((t) => !showableText.has(t));
  assert.ok(heldOnly.length > 0, "need held seed rows");
  const bufaloHtml = renderVenuePage(bufalo, views, FRI_11PM_EDT);
  for (const text of heldOnly) {
    assert.ok(!bufaloHtml.includes(text), `held leaked: ${text}`);
    assert.ok(!bufaloHtml.includes(escapeHtml(text)), `held escaped leaked: ${text}`);
  }
  assert.doesNotMatch(bufaloHtml, /ops_notes/);
});

test("quiet venue page is honest, not 404", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const quiet = venues.find((v) => v.id === "barracudas-locust-point")
    ?? venues.find((v) => v.status === "open_unverifiable" && v.deals.length === 0);
  assert.ok(quiet);
  const html = renderVenuePage(quiet, views, FRI_11PM_EDT);
  assert.match(html, new RegExp(quiet.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(html, /ops_notes/);
  // Some plain reason — notes_public or default.
  assert.match(html, /specials|prices|official|verify|Nothing listed|no specials/i);
  // No deal cards for held-free empty schedule.
  const schedule = venueScheduleByDay(quiet);
  assert.ok(schedule.every((d) => d.deals.length === 0));
});

test("price-unknown rows say so on the card instead of showing a blank", async () => {
  // Renamed 2026-08-11: these rows no longer stay held (Eric approved
  // times-only happy hours). They render, and each one states plainly that the
  // venue publishes no prices.
  const venues = await loadVenues();
  const views = await loadViews();
  const stack = venues.find((v) => v.id === "hudson-street-stackhouse");
  assert.ok(stack.deals.some((d) => d.prices_published === false));
  const html = renderVenuePage(stack, views, FRI_11PM_EDT);
  assert.match(html, /Prices not published by the venue/i);
  assert.doesNotMatch(html, /\$\d/, "a times-only venue must show no price");
});

test("boardViewForVenue picks a view that includes the neighbourhood", async () => {
  const views = await loadViews();
  const venues = await loadVenues();
  const delia = venues.find((v) => v.id === "delia-foleys");
  const board = boardViewForVenue(delia, views, defaultView(views));
  assert.ok(board.neighborhoods.includes("South Baltimore"));
  assert.equal(board.slug, "federal-hill");
  // City-wide is default / first, but back-link must stay neighbourhood-local.
  assert.notEqual(board.slug, "baltimore");
});

test("static build writes a venue page for every venue without ops_notes leaks", async () => {
  const outDir = join(ROOT, ".scratch", "static-venue-dist");
  await rm(outDir, { recursive: true, force: true });
  const { written } = await buildStatic({ outDir, now: FRI_11PM_EDT });
  const venues = await loadVenues();
  for (const v of venues) {
    const rel = `venue/${v.id}/index.html`;
    assert.ok(written.includes(rel), `missing static page ${rel}`);
    const html = await readFile(join(outDir, rel), "utf8");
    assert.doesNotMatch(html, /ops_notes/);
    assert.ok(html.includes(escapeHtml(v.name)), `name missing on ${rel}`);
  }
  // Sample held-only line must not appear on that venue's page.
  const bufalo = await readFile(join(outDir, "venue/good-vibes-cantina/index.html"), "utf8");
  assert.doesNotMatch(bufalo, /\$7 Sangria/);
  await rm(outDir, { recursive: true, force: true });
});

// Ticket: whole deal tile navigates to the venue page (stretched link, no JS,
// no wrapping <a>). Phone + source stay above the stretch. Real link colour.
test("deal cards keep a single venue-link; phone and source stay real anchors", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const boardVenues = venuesInView(venues, canton);
  const cards = cardsHtmlForDay(boardVenues, "fri", FRI_11PM_EDT);

  // At least one card with phone + source (Claddagh is verified Canton).
  assert.match(cards, /class="card"/);
  assert.match(cards, /class="venue-link"/);
  assert.match(cards, /href="tel:/);
  assert.match(cards, />source<\/a>/);

  // Never wrap the whole card in an anchor (invalid nesting with tel/source).
  assert.doesNotMatch(cards, /<a[^>]*>\s*<article/);
  assert.doesNotMatch(cards, /<article[^>]*>\s*<a[^>]*class="card"/);

  // Venue name is the one venue-link inside the card, pointing at /venue/.
  const claddagh = venues.find((v) => v.id === "claddagh-pub");
  assert.ok(claddagh);
  const escaped = escapeHtml(claddagh.name);
  assert.match(
    cards,
    new RegExp(
      `<a class="venue-link" href="/venue/${claddagh.id}">${escaped}</a>`,
    ),
  );
});

test("style.css ships the stretched-link pattern and real link colour", async () => {
  const css = await readFile(join(ROOT, "public", "style.css"), "utf8");

  // Card is the positioning context; venue-link stretch covers the tile.
  assert.match(css, /\.card\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.card\s+a\.venue-link::after\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.card\s+a\.venue-link::after\s*\{[^}]*inset:\s*0/s);

  // Phone + source (meta anchors) sit above the stretch.
  assert.match(css, /\.card\s*>\s*\.meta\s+a\s*\{[^}]*position:\s*relative/s);
  assert.match(css, /\.card\s*>\s*\.meta\s+a\s*\{[^}]*z-index:\s*1/s);

  // Global links have a real colour, not only inherit.
  assert.match(css, /^a\s*\{[^}]*color:\s*var\(--accent\)/m);
  assert.doesNotMatch(css, /^a\s*\{\s*color:\s*inherit/m);
});
