import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildHappyHourIcs } from "./src/calendar.js";
import { venuesInView } from "./src/deals.js";
import { renderMap } from "./src/map.js";
import { renderBoard } from "./src/page.js";
import { boardViewForVenue, renderVenuePage } from "./src/venue.js";
import { loadVenues } from "./src/venues.js";
import { defaultView, findView, loadViews } from "./src/views.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const STYLE_FILE = fileURLToPath(new URL("./public/style.css", import.meta.url));
const VENDOR_DIR = fileURLToPath(new URL("./public/vendor/", import.meta.url));

// Vendored static assets (Leaflet). Allow-listed filenames only — never serve
// an arbitrary path out of the directory.
const VENDOR_FILES = new Map([
  ["leaflet.css", "text/css; charset=utf-8"],
  ["leaflet.js", "text/javascript; charset=utf-8"],
]);

// Browser board scripts (day accuracy, timing groups, search).
const PUBLIC_SCRIPTS = new Map([
  ["client-day.js", "text/javascript; charset=utf-8"],
  ["client-board.js", "text/javascript; charset=utf-8"],
  ["client-search.js", "text/javascript; charset=utf-8"],
  ["client-filter.js", "text/javascript; charset=utf-8"],
]);

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;

    if (path === "/style.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(await readFile(STYLE_FILE, "utf8"));
      return;
    }

    if (path.startsWith("/client-") && path.endsWith(".js")) {
      const name = path.slice(1);
      const type = PUBLIC_SCRIPTS.get(name);
      if (type) {
        res.writeHead(200, { "content-type": type });
        res.end(await readFile(PUBLIC_DIR + name, "utf8"));
        return;
      }
    }

    if (path.startsWith("/vendor/")) {
      const name = path.slice("/vendor/".length);
      const type = VENDOR_FILES.get(name);
      if (type) {
        res.writeHead(200, { "content-type": type });
        res.end(await readFile(VENDOR_DIR + name));
        return;
      }
    }

    const views = await loadViews();

    // No view named? Send them to the default one rather than inventing a
    // homepage that would have to hard-code a neighborhood.
    if (path === "/" || path === "/index.html") {
      res.writeHead(302, { location: `/${defaultView(views).slug}` });
      res.end();
      return;
    }

    // /map on the default view — same redirect rule as the board.
    if (path === "/map" || path === "/map.html") {
      res.writeHead(302, { location: `/${defaultView(views).slug}/map` });
      res.end();
      return;
    }

    // /calendar.ics — happy-hour feed for the default view (subscribe once).
    if (path === "/calendar.ics") {
      res.writeHead(302, { location: `/${defaultView(views).slug}/calendar.ics` });
      res.end();
      return;
    }

    // /venue/<id> — one page per venue, neighbourhood-independent.
    const venueMatch = path.match(/^\/venue\/([a-z0-9-]+)\/?$/);
    if (venueMatch) {
      const all = await loadVenues();
      const venue = all.find((v) => v.id === venueMatch[1]);
      if (venue) {
        const board = boardViewForVenue(venue, views, defaultView(views));
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          renderVenuePage(venue, views, new Date(), {
            boardHref: `/${board.slug}`,
            listLabel: `Back to ${board.label}`,
            mapHref: `/${board.slug}/map`,
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Venue not found");
      return;
    }

    // /<view>/map — the interactive map for a named board.
    const mapMatch = path.match(/^\/([a-z0-9-]+)\/map$/);
    if (mapMatch) {
      const mapView = findView(views, mapMatch[1]);
      if (mapView) {
        const venues = venuesInView(await loadVenues(), mapView);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderMap(venues, mapView, views));
        return;
      }
    }

    // /<view>/calendar.ics — weekly happy hours only (not the full 63-deal wall).
    const calMatch = path.match(/^\/([a-z0-9-]+)\/calendar\.ics$/);
    if (calMatch) {
      const calView = findView(views, calMatch[1]);
      if (calView) {
        const venues = venuesInView(await loadVenues(), calView);
        const ics = buildHappyHourIcs(venues, {
          calendarName: `${calView.label} Happy Hours — Baltimore Dealz`,
        });
        res.writeHead(200, {
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": `inline; filename="${calView.slug}-happy-hours.ics"`,
          // Clients re-fetch subscribed calendars; allow short cache only.
          "cache-control": "public, max-age=300",
        });
        res.end(ics);
        return;
      }
    }

    const view = findView(views, path.slice(1));
    if (view) {
      // Every venue in the view's neighborhoods — deal cards and the collapsed
      // "no deals we can show" group both come from this list.
      const venues = venuesInView(await loadVenues(), view);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderBoard(venues, view, views));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  } catch (error) {
    console.error(error);
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Something broke loading the deals.");
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, "0.0.0.0", () => {
  console.log(`Baltimore Dealz on http://localhost:${port}`);
});
