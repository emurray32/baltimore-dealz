// City-limits logic: the official Baltimore City boundary as a polygon ring,
// a ray-cast point-in-polygon check, and the GeoJSON-ish payload the map
// script draws. Data module is boundary-ring.js; this file is the behavior.

import { CITY_BOUNDARY_RING } from "./boundary-ring.js";

// Ray-casting point-in-polygon. Ring is [lon, lat] pairs; point is lat/lon
// numbers like the venues carry. Points exactly on an edge are treated as
// inside (a venue on the line is still in the city).
export function pointInCity(lat, lon, ring = CITY_BOUNDARY_RING) {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    // On the segment? Count as inside — boundary venues are city venues.
    const cross = (lon - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (
      Math.abs(cross) < 1e-9 &&
      Math.min(xi, xj) - 1e-12 <= lon && lon <= Math.max(xi, xj) + 1e-12 &&
      Math.min(yi, yj) - 1e-12 <= lat && lat <= Math.max(yi, yj) + 1e-12
    ) {
      return true;
    }
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// Venue-level check: true/false when the venue carries coordinates, null when
// it doesn't (unmappable venues can't be checked, and that's not an error).
export function venueInCity(venue) {
  if (typeof venue.lat !== "number" || typeof venue.lon !== "number") return null;
  return pointInCity(venue.lat, venue.lon);
}

// Names of tracked venues whose coordinates fall outside the city line.
// Used by the test suite as a data-quality tripwire, not to drop venues —
// a county venue with a real Baltimore deal stays on the board with a note.
export function venuesOutsideCity(venues) {
  return venues.filter((venue) => venueInCity(venue) === false);
}

// Leaflet-ready [[lat, lon], ...] polyline for the map script. Closed ring:
// first point repeated at the end so the line joins up.
export function cityBoundaryPolyline(ring = CITY_BOUNDARY_RING) {
  const line = ring.map(([lon, lat]) => [lat, lon]);
  line.push([...line[0]]);
  return line;
}
