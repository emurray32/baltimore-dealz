// Pre-render every board + map into dist/ for GitHub Pages (static host).
// Zero npm deps — plain Node. Reuses renderBoard / renderMap and the same
// venuesInView / defaultView routing the live server uses.
//
// Output layout (relative asset paths so project Pages + custom domains both work):
//   dist/index.html              → client redirect to default view
//   dist/map/index.html          → client redirect to default view's map
//   dist/<view>/index.html       → board
//   dist/<view>/map/index.html   → map
//   dist/style.css, vendor/*, client-*.js

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { venuesInView } from "../src/deals.js";
import { renderMap } from "../src/map.js";
import { renderBoard } from "../src/page.js";
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

  const written = ["index.html", "map/index.html", "style.css", "client-day.js", "client-board.js"];

  for (const view of views) {
    const venues = venuesInView(allVenues, view);

    // Board lives at dist/<slug>/index.html → assets one level up.
    const boardHtml = renderBoard(venues, view, views, now, {
      styleHref: "../style.css",
      mapHref: "map/",
      viewHref: (slug) => `../${slug}/`,
      staticClient: true,
      clientDaySrc: "../client-day.js",
      clientBoardSrc: "../client-board.js",
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
  }

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
