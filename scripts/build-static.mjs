// Pre-render every board + map into dist/ for GitHub Pages (static host).
// Zero npm deps — plain Node. Reuses renderBoard / renderMap and the same
// venuesInView / defaultView routing the live server uses.
//
// Output layout (relative asset paths so project Pages + custom domains both work):
//   dist/index.html              → client redirect to default view
//   dist/map/index.html          → client redirect to default view's map
//   dist/calendar.ics            → happy-hour feed (default view body)
//   dist/<view>/index.html       → board
//   dist/<view>/map/index.html   → map
//   dist/<view>/calendar.ics     → happy-hour feed for that view
//   dist/style.css, vendor/*, client-*.js

// How many months ahead the static host pre-renders. The live server is not
// bounded -- it serves any month from ?month=YYYY-MM.
const STATIC_MONTHS = 6;

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHappyHourIcs } from "../src/calendar.js";
import { venuesInView } from "../src/deals.js";
import { addMonths, loadEvents } from "../src/events.js";
import { renderMap } from "../src/map.js";
import { renderCalendar } from "../src/month.js";
import { renderBoard } from "../src/page.js";
import { boardViewForVenue, renderVenuePage } from "../src/venue.js";
import { loadVenues } from "../src/venues.js";
import { defaultView, loadViews } from "../src/views.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PUBLIC = join(ROOT, "public");

function redirectHtml(target, label) {
  // GitHub Pages has no server-side 302. Meta + JS covers bots and browsers.
  const safe = target.replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${safe}">
  <link rel="canonical" href="${safe}">
  <title>Baltimore Dealz</title>
  <script>location.replace(${JSON.stringify(target)});</script>
</head>
<body>
  <p><a href="${safe}">${label}</a></p>
</body>
</html>
`;
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

export async function buildStatic({ outDir = DIST, now = new Date() } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const views = await loadViews();
  const allVenues = await loadVenues();
  const fallback = defaultView(views);

  // Static assets + client day logic (copied, not bundled).
  await cp(join(PUBLIC, "style.css"), join(outDir, "style.css"));
  await cp(join(PUBLIC, "vendor"), join(outDir, "vendor"), { recursive: true });
  await cp(join(PUBLIC, "client-day.js"), join(outDir, "client-day.js"));
  await cp(join(PUBLIC, "client-board.js"), join(outDir, "client-board.js"));
  await cp(join(PUBLIC, "client-search.js"), join(outDir, "client-search.js"));
  await cp(join(PUBLIC, "client-filter.js"), join(outDir, "client-filter.js"));

  // / and /map — same redirect targets the live server uses.
  await write(
    join(outDir, "index.html"),
    redirectHtml(`./${fallback.slug}/`, `Tonight in ${fallback.label}`),
  );
  await write(
    join(outDir, "map", "index.html"),
    redirectHtml(`../${fallback.slug}/map/`, `${fallback.label} map`),
  );

  const written = [
    "index.html",
    "map/index.html",
    "style.css",
    "client-day.js",
    "client-board.js",
    "client-search.js",
    "client-filter.js",
  ];

  const events = await loadEvents();
  const stampNow = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  for (const view of views) {
    const venues = venuesInView(allVenues, view);

    // Board lives at dist/<slug>/index.html → assets one level up.
    const boardHtml = renderBoard(venues, view, views, now, {
      styleHref: "../style.css",
      mapHref: "map/",
      calendarHref: "calendar.ics",
      monthHref: "calendar/",
      viewHref: (slug) => `../${slug}/`,
      venueHref: (id) => `../venue/${id}/`,
      staticClient: true,
      clientDaySrc: "../client-day.js",
      clientBoardSrc: "../client-board.js",
      clientSearchSrc: "../client-search.js",
      clientFilterSrc: "../client-filter.js",
    });
    const boardPath = join(view.slug, "index.html");
    await write(join(outDir, boardPath), boardHtml);
    written.push(boardPath);

    // Map lives at dist/<slug>/map/index.html → assets two levels up.
    const mapHtml = renderMap(venues, view, views, now, {
      styleHref: "../../style.css",
      leafletCssHref: "../../vendor/leaflet.css",
      leafletJsHref: "../../vendor/leaflet.js",
      listHref: "../",
      mapHref: (slug) => `../../${slug}/map/`,
    });
    const mapPath = join(view.slug, "map", "index.html");
    await write(join(outDir, mapPath), mapHtml);
    written.push(mapPath);

    // Happy-hour subscribe feed (same body the live server serves).
    const ics = buildHappyHourIcs(venues, {
      calendarName: `${view.label} Happy Hours — Baltimore Dealz`,
      now,
    });
    const icsPath = join(view.slug, "calendar.ics");
    await write(join(outDir, icsPath), ics);
    written.push(icsPath);

    // Month pages. A static host has no query strings, so each month is its own
    // file and the nav links file-to-file. STATIC_MONTHS bounds the window --
    // the live server still serves any month via ?month=YYYY-MM.
    const first = { year: now.getFullYear(), month: now.getMonth() + 1 };
    for (let i = 0; i < STATIC_MONTHS; i += 1) {
      const when = addMonths(first.year, first.month, i);
      const stamp = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
      const inWindow = (y, m) => {
        const delta = (y * 12 + m - 1) - (first.year * 12 + first.month - 1);
        return delta >= 0 && delta < STATIC_MONTHS;
      };
      // Calendar lives at dist/<slug>/calendar/<stamp>/ -> assets three levels up.
      const html = renderCalendar(venues, events, view, views, when, now, {
        styleHref: "../../../style.css",
        boardHref: "../../",
        venueHref: (id) => `../../../venue/${id}/`,
        // Neighbouring months that were not pre-rendered would be dead links.
        calendarHref: (slug, y, m) => (inWindow(y, m) ? `../${stamp(y, m)}/` : null),
      });
      const monthPath = join(view.slug, "calendar", stamp(when.year, when.month), "index.html");
      await write(join(outDir, monthPath), html);
      written.push(monthPath);
    }

    // dist/<slug>/calendar/ -> the current month, so the board's link lands.
    const landing = join(view.slug, "calendar", "index.html");
    await write(
      join(outDir, landing),
      redirectHtml(`${stampNow}/`, `${view.label} calendar`),
    );
    written.push(landing);
  }

  // One page per venue at dist/venue/<id>/index.html — neighbourhood-independent.
  for (const venue of allVenues) {
    const board = boardViewForVenue(venue, views, fallback);
    const html = renderVenuePage(venue, views, now, {
      styleHref: "../../style.css",
      boardHref: `../../${board.slug}/`,
      listLabel: `Back to ${board.label}`,
      mapHref: `../../${board.slug}/map/`,
    });
    const venuePath = join("venue", venue.id, "index.html");
    await write(join(outDir, venuePath), html);
    written.push(venuePath);
  }

  // Root calendar.ics copies the default view so a single stable URL works on
  // static hosts (no 302). Live server still 302s /calendar.ics → /<slug>/…
  const defaultIcs = await readFile(join(outDir, fallback.slug, "calendar.ics"), "utf8");
  await write(join(outDir, "calendar.ics"), defaultIcs);
  written.push("calendar.ics");

  return { outDir, views, written, defaultSlug: fallback.slug };
}

// CLI entry — `node scripts/build-static.mjs`
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/build-static.mjs")) {
  const result = await buildStatic();
  console.log(
    `Built ${result.written.length} paths into ${result.outDir} (default view: ${result.defaultSlug})`,
  );
  for (const path of result.written) console.log(`  ${path}`);
}
