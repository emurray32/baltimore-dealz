import test from "node:test";
import assert from "node:assert/strict";
import { mapCenter, mapPayload, popupHtml, renderMap, unmappableNames } from "../src/map.js";
import { loadVenues } from "../src/venues.js";
import { loadViews, findView } from "../src/views.js";
import { venuesInView } from "../src/deals.js";

const baseVenue = {
  id: "test-venue",
  name: "Test Venue",
  neighborhood: "Canton",
  status: "verified",
  address: "1 Test St, Baltimore, MD 21224",
  phone: "(410) 555-0100",
  source_url: "https://example.com/",
  source_type: "venue_website",
  last_verified: "2026-08-03",
  lat: 39.28,
  lon: -76.57,
  coords_source: "test",
  deals: [
    {
      days: ["mon", "tue", "wed", "thu", "fri"],
      items: [
        { text: "$3 Bud Light", price: "$3" },
        { text: "Crushes", price: "$7" },
      ],
      start: 960,
      end: 1140,
      time_window: "4pm-7pm",
    },
  ],
};

const view = { slug: "canton", label: "Canton", neighborhoods: ["Canton", "Brewers Hill"] };

test("payload carries one entry per venue with coordinates", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const canton = findView(views, "canton");
  const inView = venuesInView(venues, canton);
  const payload = mapPayload(inView);
  const withCoords = inView.filter((v) => typeof v.lat === "number" && typeof v.lon === "number");
  assert.equal(payload.length, withCoords.length);
  assert.ok(payload.length > 0);
});

test("a venue with no coordinates is unmappable, not silently dropped", () => {
  const venues = [{ ...baseVenue, lat: undefined, lon: undefined }];
  assert.equal(mapPayload(venues).length, 0);
  assert.deepEqual(unmappableNames(venues), ["Test Venue"]);
  const html = renderMap(venues, view);
  assert.match(html, /Not on the map — no verified location: Test Venue/);
});

test("popup renders the deal items with their prices", () => {
  const [entry] = mapPayload([baseVenue]);
  const html = popupHtml(entry);
  assert.match(html, /\$3 Bud Light/);
  assert.match(html, /Crushes/);
  assert.match(html, /4pm-7pm/);
  assert.match(html, /1 Test St/);
  assert.match(html, /last verified 2026-08-03/);
  assert.doesNotMatch(html, /Prices not published/);
});

test("prices-not-published branch says so plainly", () => {
  const venue = {
    ...baseVenue,
    deals: [{ ...baseVenue.deals[0], prices_published: false }],
  };
  const [entry] = mapPayload([venue]);
  assert.equal(entry.deals[0].prices_published, false);
  const html = popupHtml(entry);
  assert.match(html, /Prices not published by the venue\./);
});

test("no last_verified — the popup simply omits the date line", () => {
  const venue = { ...baseVenue, last_verified: undefined };
  const [entry] = mapPayload([venue]);
  const html = popupHtml(entry);
  assert.doesNotMatch(html, /last verified/);
  assert.match(html, /source/); // the rest of the meta line survives
});

test("a venue with nothing showable gets the reason, not an empty deal list", () => {
  const venue = {
    ...baseVenue,
    status: "open_unverifiable",
    deals: [],
    notes_public: "Publishes a monthly promo as an image we cannot read.",
  };
  const [entry] = mapPayload([venue]);
  assert.equal(entry.showable, false);
  assert.equal(entry.deals.length, 0);
  const html = popupHtml(entry);
  assert.match(html, /image we cannot read/);
  assert.doesNotMatch(html, /<ul><\/ul>/);
});

test("held deals do not reach the popup", () => {
  const venue = {
    ...baseVenue,
    deals: [{ ...baseVenue.deals[0], status: "held" }],
  };
  const [entry] = mapPayload([venue]);
  assert.equal(entry.deals.length, 0);
  assert.equal(entry.showable, false);
});

test("map center is the mean of the venues shown, not a hard-coded point", () => {
  const payload = mapPayload([baseVenue, { ...baseVenue, id: "b", lat: 39.3, lon: -76.6 }]);
  const [lat, lon] = mapCenter(payload);
  assert.equal(lat, 39.29);
  assert.equal(lon, -76.585);
});

test("page markup carries the payload, popups, center, and the vendored assets", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const canton = findView(views, "canton");
  const html = renderMap(venuesInView(venues, canton), canton, views);
  assert.match(html, /window\.BD_MAP_POINTS = \[/);
  assert.match(html, /window\.BD_MAP_POPUPS = \{/);
  assert.match(html, /window\.BD_MAP_CENTER = \[/);
  assert.match(html, /\/vendor\/leaflet\.css/);
  assert.match(html, /\/vendor\/leaflet\.js/);
  assert.match(html, /tile\.openstreetmap\.org/);
  // No key, no account, no third-party JS.
  assert.doesNotMatch(html, /api[_-]?key/i);
  assert.doesNotMatch(html, /unpkg|cdn\.jsdelivr|googleapis/);
  // List-view link back to the board.
  assert.match(html, /href="\/canton"[^>]*>List view/);
});

test("script-block breakout is impossible through venue data", () => {
  const venue = { ...baseVenue, name: 'Evil </script><script>alert(1)</script>' };
  const html = renderMap([venue], view);
  assert.doesNotMatch(html, /<\/script><script>alert/);
});

test("venue names with HTML in them are escaped in the popup", () => {
  const venue = { ...baseVenue, name: '<img src=x onerror=alert(1)>' };
  const [entry] = mapPayload([venue]);
  const html = popupHtml(entry);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x/);
});
