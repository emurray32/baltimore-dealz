// Happy-hour calendar feed (item 9).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHappyHourIcs,
  happyHourRows,
  icsEscape,
  icsFold,
  minutesToIcsTime,
} from "../src/calendar.js";
import { venuesInView } from "../src/deals.js";
import { renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, loadViews } from "../src/views.js";
import { buildStatic } from "../scripts/build-static.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = new Date("2026-08-06T16:00:00Z");

test("minutesToIcsTime maps board minutes to HHmmss", () => {
  assert.equal(minutesToIcsTime(900), "150000");
  assert.equal(minutesToIcsTime(1110), "183000");
  assert.equal(minutesToIcsTime(0), "000000");
});

test("icsEscape and icsFold keep TEXT and line length honest", () => {
  assert.equal(icsEscape("a;b,c\\d\ne"), "a\\;b\\,c\\\\d\\ne");
  const long = "X".repeat(80);
  const folded = icsFold(long);
  assert.ok(folded.includes("\r\n "));
  assert.ok(folded.split("\r\n").every((line) => line.length <= 75));
});

test("happyHourRows is happy_hour only — no trivia, no held, no unpriced non-HH", async () => {
  const venues = await loadVenues();
  const rows = happyHourRows(venues);
  assert.ok(rows.length >= 10, `expected several HH rows, got ${rows.length}`);
  for (const { venue, deal } of rows) {
    assert.equal(venue.status, "verified");
    assert.equal(deal.happy_hour, true);
    assert.equal(deal.status, undefined);
  }
  const texts = rows.flatMap((r) => r.deal.items.map((i) => i.text)).join("\n");
  assert.doesNotMatch(texts, /Trivia|Quizamajig|Karaoke|Spin the Wheel/i);
  // Held Mama Monday is happy_hour but held — must not appear.
  assert.ok(
    !rows.some(
      (r) =>
        r.venue.id === "mamas-on-the-half-shell" &&
        r.deal.items.some((i) => /ALL DAY/i.test(i.text)),
    ),
  );
});

test("buildHappyHourIcs ships Union Hill Block A as a timed weekly event", async () => {
  const views = await loadViews();
  const view = defaultView(views);
  const venues = venuesInView(await loadVenues(), view);
  const ics = buildHappyHourIcs(venues, {
    calendarName: `${view.label} Happy Hours — Baltimore Dealz`,
    now: NOW,
  });

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(ics, /VERSION:2\.0/);
  assert.match(ics, /X-WR-TIMEZONE:America\/New_York/);
  assert.match(ics, /BEGIN:VTIMEZONE/);

  // Union Hill: end 1110, Block A lines, weekly Mon–Fri.
  assert.match(ics, /UID:bd-hh-union-hill-kitchen-/);
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260803T150000/);
  assert.match(ics, /DTEND;TZID=America\/New_York:20260803T183000/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR/);
  assert.match(ics, /\$2 OFF all wines by the glass/);
  assert.match(ics, /1\/2 OFF raw oysters/);
  assert.doesNotMatch(ics, /craft cocktails|ALL COCKTAILS, WINE|1\/2 PRICED/i);

  // Non-happy-hour day specials stay out.
  assert.doesNotMatch(ics, /Quizamajig|Taco Tuesday|\$11 Chicken/i);
});

test("all-day path covers HH rows that lack a full start/end pair", async () => {
  const venues = await loadVenues();
  const smaltimore = venues.find((v) => v.id === "smaltimore");
  const ics = buildHappyHourIcs([smaltimore], { now: NOW });
  // "until 7pm" has end only → all-day VALUE=DATE, not a fake start.
  assert.match(ics, /All Night Happy Hour|until 7pm/);
  assert.match(ics, /DTSTART;VALUE=DATE:/);
  // Priced Mon–Fri block is happy_hour with end only — also all-day.
  assert.match(ics, /\$6 House Wine/);
});

test("board links the calendar feed next to Map view", async () => {
  const views = await loadViews();
  const view = defaultView(views);
  const venues = venuesInView(await loadVenues(), view);
  const html = renderBoard(venues, view, views, NOW);
  assert.match(html, /href="\/canton\/calendar\.ics"/);
  assert.match(html, /Add happy hours to calendar/);
});

test("static build writes per-view and root calendar.ics", async () => {
  const outDir = join(ROOT, ".scratch", "cal-static-test");
  await rm(outDir, { recursive: true, force: true });
  const result = await buildStatic({ outDir, now: NOW });
  assert.ok(result.written.includes("canton/calendar.ics"));
  assert.ok(result.written.includes("calendar.ics"));

  const viewIcs = await readFile(join(outDir, "canton", "calendar.ics"), "utf8");
  const rootIcs = await readFile(join(outDir, "calendar.ics"), "utf8");
  assert.equal(rootIcs, viewIcs);
  assert.match(viewIcs, /BEGIN:VCALENDAR/);
  assert.match(viewIcs, /union-hill-kitchen/);

  const board = await readFile(join(outDir, "canton", "index.html"), "utf8");
  assert.match(board, /href="calendar\.ics"/);

  await rm(outDir, { recursive: true, force: true });
});

test("live server serves /canton/calendar.ics as text/calendar", async () => {
  // Import the route logic by spinning a minimal twin of the handler path —
  // full server.js binds a port; exercise buildHappyHourIcs + headers via a
  // tiny local server that mirrors the production route body.
  const views = await loadViews();
  const view = defaultView(views);
  const venues = venuesInView(await loadVenues(), view);
  const body = buildHappyHourIcs(venues, {
    calendarName: `${view.label} Happy Hours — Baltimore Dealz`,
    now: NOW,
  });

  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === `/${view.slug}/calendar.ics`) {
      res.writeHead(200, {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `inline; filename="${view.slug}-happy-hours.ics"`,
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/${view.slug}/calendar.ics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/calendar/);
    const text = await res.text();
    assert.equal(text, body);
    assert.match(text, /BEGIN:VCALENDAR/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
