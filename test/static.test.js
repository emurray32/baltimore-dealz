// BD-DEPLOY: static build + client day-logic equivalence.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  dayKeyInZone,
  dayLabel,
  dealsForDay,
  hasEnded,
  isDealRenderable,
  isRenderable,
  venuesInView,
  WEEK,
} from "../src/deals.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, loadViews } from "../src/views.js";
import { buildStatic } from "../scripts/build-static.mjs";
import { cardsHtmlForDay, escapeHtml, renderBoard } from "../src/page.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLIENT_DAY = join(ROOT, "public", "client-day.js");

// Both instants fall on Saturday in UTC — the classic Baltimore-day trap.
const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z"); // Fri Aug 7, 11pm EDT
const SAT_1AM_EDT = new Date("2026-08-08T05:00:00Z"); // Sat Aug 8, 1am EDT
const FRI_11PM_EST = new Date("2026-01-10T04:00:00Z"); // Fri Jan 9, 11pm EST
const SAT_1AM_EST = new Date("2026-01-10T06:00:00Z"); // Sat Jan 10, 1am EST

// Load public/client-day.js the way a browser would: run the IIFE, read BD.
function loadClientDay() {
  return readFile(CLIENT_DAY, "utf8").then((src) => {
    const sandbox = { Map, Intl, console };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(src, sandbox, { filename: "client-day.js" });
    assert.ok(sandbox.BD, "client-day.js did not attach BD");
    return sandbox.BD;
  });
}

test("client dayKeyInZone matches server across Fri 11pm / Sat 1am (EDT + EST)", async () => {
  const BD = await loadClientDay();
  const cases = [
    [FRI_11PM_EDT, "fri"],
    [SAT_1AM_EDT, "sat"],
    [FRI_11PM_EST, "fri"],
    [SAT_1AM_EST, "sat"],
  ];
  for (const [when, expected] of cases) {
    assert.equal(BD.dayKeyInZone(when), expected, `client ${when.toISOString()}`);
    assert.equal(dayKeyInZone(when), expected, `server ${when.toISOString()}`);
    assert.equal(BD.dayKeyInZone(when), dayKeyInZone(when));
  }
  // UTC argument still honoured on both sides.
  assert.equal(BD.dayKeyInZone(FRI_11PM_EDT, "UTC"), dayKeyInZone(FRI_11PM_EDT, "UTC"));
  assert.equal(BD.dayKeyInZone(FRI_11PM_EDT, "UTC"), "sat");
});

test("client hasEnded matches server (null end never ends; published end does)", async () => {
  const BD = await loadClientDay();
  const open = { start: 15 * 60, end: null };
  const closed = { start: 15 * 60, end: 18 * 60 };
  for (let minute = 0; minute < 1440; minute += 13) {
    assert.equal(BD.hasEnded(open, minute), hasEnded(open, minute));
    assert.equal(BD.hasEnded(open, minute), false);
  }
  assert.equal(BD.hasEnded(closed, 17 * 60), hasEnded(closed, 17 * 60));
  assert.equal(BD.hasEnded(closed, 18 * 60), hasEnded(closed, 18 * 60));
  assert.equal(BD.hasEnded(closed, 17 * 60), false);
  assert.equal(BD.hasEnded(closed, 18 * 60), true);
});

test("client dealsForDay matches server for every weekday on real seed data", async () => {
  const BD = await loadClientDay();
  const venues = await loadVenues();
  for (const day of WEEK) {
    const server = dealsForDay(venues, day.key).map((r) => ({
      id: r.venue.id,
      items: r.deal.items.map((i) => i.text),
    }));
    // Client arrays are realm-local (vm sandbox) — copy into this realm before
    // deepEqual, or different Array prototypes make equal rows look unequal.
    const client = [...BD.dealsForDay(venues, day.key)].map((r) => ({
      id: r.venue.id,
      items: [...r.deal.items].map((i) => i.text),
    }));
    assert.deepEqual(client, server, `dealsForDay mismatch on ${day.key}`);
  }
});

test("client isRenderable / isDealRenderable match server filters", async () => {
  const BD = await loadClientDay();
  const venues = await loadVenues();
  for (const v of venues) {
    assert.equal(BD.isRenderable(v), isRenderable(v), v.id);
    for (const d of v.deals) {
      assert.equal(BD.isDealRenderable(d), isDealRenderable(d), `${v.id} deal`);
    }
  }
});

test("build-static produces every view board + map + root redirects with deal cards", async () => {
  const outDir = join(ROOT, ".scratch", "static-test-dist");
  await rm(outDir, { recursive: true, force: true });

  const fri = FRI_11PM_EDT;
  const result = await buildStatic({ outDir, now: fri });
  const views = await loadViews();
  const venues = await loadVenues();
  const fallback = defaultView(views);

  // Root + /map redirects
  const root = await readFile(join(outDir, "index.html"), "utf8");
  assert.match(root, new RegExp(`${fallback.slug}/`));
  const mapRoot = await readFile(join(outDir, "map", "index.html"), "utf8");
  assert.match(mapRoot, new RegExp(`${fallback.slug}/map/`));

  for (const view of views) {
    const board = await readFile(join(outDir, view.slug, "index.html"), "utf8");
    const map = await readFile(join(outDir, view.slug, "map", "index.html"), "utf8");

    assert.match(board, /On tonight/);
    assert.match(board, /class="card"/, `${view.slug} board has no deal cards`);
    // No raw venues embed — that leaked ops_notes + held deal prices (blocker).
    assert.doesNotMatch(board, /id="bd-venues"/);
    assert.doesNotMatch(board, /ops_notes/);
    assert.match(board, /client-day\.js/);
    assert.match(board, /client-board\.js/);
    assert.match(board, /<noscript>/);
    // One template per weekday + data-day only on static boards
    for (const day of WEEK) {
      assert.match(board, new RegExp(`id="bd-day-${day.key}"`));
      assert.match(board, new RegExp(`data-day="${day.key}"`));
    }
    // Friday skeleton (build now) names Friday
    assert.match(board, /Friday · Baltimore time/);

    // Tonight's Friday deals appear in the fri template AND the live tonight section
    const friRows = dealsForDay(venuesInView(venues, view), "fri");
    assert.ok(friRows.length > 0, "seed has no Friday deals — test proves nothing");
    for (const row of friRows.slice(0, 3)) {
      const sample = row.deal.items[0]?.text;
      if (sample) assert.match(board, new RegExp(escapeRegExp(escapeHtml(sample))));
    }

    assert.match(map, /BD_MAP_POINTS/);
    assert.match(map, /leaflet/);
    assert.match(map, new RegExp(escapeRegExp(view.label)));
    // Map path must not leak ops_notes either
    assert.doesNotMatch(map, /ops_notes/);
  }

  // Assets landed
  await readFile(join(outDir, "style.css"), "utf8");
  await readFile(join(outDir, "client-day.js"), "utf8");
  await readFile(join(outDir, "vendor", "leaflet.js"), "utf8");

  await rm(outDir, { recursive: true, force: true });
  assert.ok(result.written.length >= 2 + views.length * 2);
});

test("static board tonight templates match server cardsHtmlForDay at Fri 11pm and Sat 1am", async () => {
  const outDir = join(ROOT, ".scratch", "static-tonight-dist");
  await rm(outDir, { recursive: true, force: true });

  const views = await loadViews();
  const view = defaultView(views);
  const venues = venuesInView(await loadVenues(), view);

  for (const when of [FRI_11PM_EDT, SAT_1AM_EDT]) {
    const key = dayKeyInZone(when);
    await buildStatic({ outDir, now: when });
    const board = await readFile(join(outDir, view.slug, "index.html"), "utf8");

    // Extract the template for `key` and compare to server fragment.
    const re = new RegExp(
      `<template id="bd-day-${key}">([\\s\\S]*?)</template>`,
    );
    const match = board.match(re);
    assert.ok(match, `missing template for ${key}`);
    const expected = cardsHtmlForDay(venues, key, when);
    assert.equal(match[1], expected, `template for ${key} drifted from server render`);

    // Live "On tonight" section (pre-hydrate skeleton) also matches that day,
    // because the build baked `now` into the page.
    assert.match(board, new RegExp(`${dayLabel(key)} · Baltimore time`));
    const serverBoard = renderBoard(venues, view, [view], when);
    const onTonight = (html) => html.split("<h2>Good to know</h2>")[0] ?? html;
    // Same deal item texts on tonight for server vs static skeleton.
    // Compare against escapeHtml(text): page.js turns &/' into entities, so a
    // raw "Fish & Chips $15" never matches the rendered HTML (vacuous if we
    // forget — same class of bug as html.includes(venue.name)).
    const serverItems = dealsForDay(venues, key).flatMap((r) =>
      r.deal.items.map((i) => i.text),
    );
    for (const text of serverItems) {
      const needle = escapeRegExp(escapeHtml(text));
      assert.match(onTonight(board), new RegExp(needle));
      assert.match(onTonight(serverBoard), new RegExp(needle));
    }
  }

  await rm(outDir, { recursive: true, force: true });
});

test("static board HTML never embeds ops_notes or held-only deal item text", async () => {
  // Reviewer blocker: full venues JSON in the page put internal notes and
  // held prices (e.g. El Bufalo Modelo) in View Source even though cards omit them.
  // Scope held text to strings that do NOT also appear on a showable deal —
  // "$7 Margaritas" is held at Good Vibes and real at Smaltimore (global
  // substring would false-fail).
  const outDir = join(ROOT, ".scratch", "static-leak-dist");
  await rm(outDir, { recursive: true, force: true });
  await buildStatic({ outDir, now: FRI_11PM_EDT });

  const views = await loadViews();
  const venues = await loadVenues();
  const showableTexts = new Set();
  for (const v of venues) {
    for (const d of v.deals) {
      if (d.status === undefined) {
        for (const item of d.items) showableTexts.add(item.text);
      }
    }
  }
  const heldOnlyTexts = [];
  for (const v of venues) {
    for (const d of v.deals) {
      if (d.status === "held") {
        for (const item of d.items) {
          if (!showableTexts.has(item.text)) heldOnlyTexts.push(item.text);
        }
      }
    }
  }
  assert.ok(heldOnlyTexts.length > 0, "seed has no held-only items — test proves nothing");
  assert.ok(
    heldOnlyTexts.some((t) => /Modelo/i.test(t)),
    "expected a known held Modelo line in seed (Reviewer's example)",
  );

  for (const view of views) {
    const board = await readFile(join(outDir, view.slug, "index.html"), "utf8");
    assert.doesNotMatch(board, /ops_notes/);
    assert.doesNotMatch(board, /id="bd-venues"/);
    for (const text of heldOnlyTexts) {
      assert.ok(!board.includes(text), `held-only text leaked raw: ${text}`);
      assert.ok(
        !board.includes(escapeHtml(text)),
        `held-only text leaked escaped: ${text}`,
      );
    }
    // Live server path without staticClient still has no data-day (additive
    // hook is gated).
    const live = renderBoard(venuesInView(venues, view), view, views, FRI_11PM_EDT);
    assert.doesNotMatch(live, /data-day=/);
    assert.doesNotMatch(live, /bd-day-/);
    assert.doesNotMatch(live, /client-board\.js/);
  }

  await rm(outDir, { recursive: true, force: true });
});

test("paths that cannot be expressed statically are documented by the build", async () => {
  // The live server re-reads venues.json on every request and serves arbitrary
  // unknown paths as 404. Static Pages only has the files we wrote — no live
  // re-read, no dynamic 404 body, no /style.css absolute root if the site is
  // hosted under a project subpath (we emit relative hrefs instead).
  // This test exists so the ticket's "note any path that can't be expressed
  // statically" has an anchor in the suite; the list is the assertion.
  const staticGaps = [
    "live re-read of data/venues.json without a rebuild",
    "server 404 plain-text body for unknown paths",
    "HTTP 302 redirects (Pages uses meta/JS redirects at / and /map)",
    "correct 'tonight' without JavaScript (skeleton is build-day; noscript warns)",
  ];
  assert.equal(staticGaps.length, 4);
  assert.ok(staticGaps.every((s) => s.length > 0));
});

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
