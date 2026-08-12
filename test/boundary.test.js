// City-limits tests: the boundary module itself, and every tracked venue's
// coordinates checked against the official Baltimore City polygon.
import test from "node:test";
import assert from "node:assert/strict";

import {
  cityBoundaryPolyline,
  pointInCity,
  venueInCity,
  venuesOutsideCity,
} from "../src/boundary.js";
import { renderMap } from "../src/map.js";
import { loadVenues } from "../src/venues.js";

test("known city points are inside, known county points are outside", () => {
  // Canton Square — deep inside the city.
  assert.equal(pointInCity(39.2806, -76.5756), true);
  // Inner Harbor.
  assert.equal(pointInCity(39.2858, -76.6131), true);
  // Towson (county seat) — just north of the line, must be outside.
  assert.equal(pointInCity(39.4015, -76.6019), false);
  // Dundalk — east, Baltimore County.
  assert.equal(pointInCity(39.2507, -76.5205), false);
  // Catonsville — west, Baltimore County.
  assert.equal(pointInCity(39.2721, -76.732), false);
});

test("pointInCity rejects non-numbers instead of throwing", () => {
  assert.equal(pointInCity("39.28", -76.57), false);
  assert.equal(pointInCity(undefined, undefined), false);
});

test("venueInCity is null without coordinates, boolean with them", () => {
  assert.equal(venueInCity({ lat: 39.2806, lon: -76.5756 }), true);
  assert.equal(venueInCity({ lat: 39.4015, lon: -76.6019 }), false);
  assert.equal(venueInCity({}), null);
  assert.equal(venueInCity({ lat: 39.2806 }), null);
});

test("the boundary polyline is lat/lon ordered and closed", () => {
  const line = cityBoundaryPolyline();
  assert.ok(line.length > 100);
  assert.deepEqual(line[0], line[line.length - 1]);
  // Baltimore latitudes are ~39.2–39.4, longitudes ~-76.5 to -76.7.
  for (const [lat, lon] of line) {
    assert.ok(lat > 39.1 && lat < 39.5, `lat ${lat} out of Baltimore range`);
    assert.ok(lon > -76.8 && lon < -76.4, `lon ${lon} out of Baltimore range`);
  }
});

test("every map page ships the city boundary payload", async () => {
  const venues = await loadVenues();
  const view = { slug: "canton", label: "Canton", neighborhoods: ["Canton"] };
  const html = renderMap(venues, view, [view]);
  assert.match(html, /window\.BD_CITY_BOUNDARY = \[\[/);
  assert.match(html, /Baltimore City limits/);
});

test("data tripwire: no tracked venue sits outside the city line", async () => {
  const venues = await loadVenues();
  const outside = venuesOutsideCity(venues);
  assert.deepEqual(
    outside.map((v) => `${v.name} (${v.address ?? "no address"})`),
    [],
    "venues with coordinates outside Baltimore City — verify or fix coords",
  );
});
