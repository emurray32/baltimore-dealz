# Baltimore Dealz

A board of Baltimore bar and restaurant specials — what's on tonight, by neighborhood.

## Run it

```bash
npm start
```

Then open http://localhost:3000. It redirects to the default board (`/canton`).
No install step, no database, no accounts — plain Node (v20+), zero dependencies.

## Test it

```bash
npm test
```

## Where the deals live

All of it is in [`data/venues.json`](data/venues.json). One entry per venue:

```json
{
  "id": "hucks-american-craft",
  "name": "Huck's American Craft",
  "neighborhood": "Canton",
  "status": "verified",
  "address": "3728 Hudson St, Baltimore, MD 21224",
  "phone": "(443) 438-3380",
  "source_url": "https://hucksamericancraft.com",
  "source_type": "venue_website",
  "last_verified": "2026-08-03",
  "notes": "UGA game days: ...",
  "deals": [
    { "days": ["sat", "sun"], "items": ["Brunch", "$6 brunch drinks"], "time_window": "10am-2pm" }
  ]
}
```

`days` uses `mon tue wed thu fri sat sun`. `time_window` is optional and is free
text as the venue words it. Adding a venue means adding one object to that
array — nothing else changes. The file is re-read on every request, so a crawler
can rewrite it in place without a restart.

### Where the deal data comes from

`data/venues.json` is derived by hand from `RESEARCH/CANTON_DEALS.md`, the
research master file. The exact state it was derived from is recorded in the
file's own `derived_from` field, and a test pins it. Never regex a migration
over this data: `Bmore Trivia — win a $50 gift card` has no price, and any
grab-the-dollar-amount pass puts a $50 chip on a free trivia night.

### Times

Every deal carries `start` and `end` as minutes past midnight, or `null`, plus a
source-faithful `time_window` string for display. **`end: null` means the venue
published no end time** — `hasEnded()` can never return true for it, so a
late-night deal cannot read "done for today". Huck's is the proof case: their
kitchen closes at 10pm and their nightcaps start at 11pm.

### Prices

`price` is an optional **string** on each item, because `BOGO`, `1/2 off` and
`Free` are real prices a number cannot hold. Three no-price states stay distinct:

| State | Means |
|---|---|
| item has no `price` | the item has no price (trivia, brunch) |
| deal has `prices_published: false` | the venue published times but no prices |
| deal has `status: "held"` | we can't state it honestly; never renders |

### Notes

`notes_public` renders. `ops_notes` never does — it holds crawler warnings, cert
exceptions and conflict logs. A test fails if an `ops_note` reaches the page.

### status — what shows up and what doesn't

| status | Deal cards? | Use it for |
|---|---|---|
| `verified` | yes (unless every deal is held) | We have a deal from an official source |
| `open_unverifiable` | **never** | The place is open, but no deal we can honestly publish |

Unverified venues — and verified venues whose only deals are held (El Bufalo) —
appear in a collapsed **"no deals we can show"** group: name, address, and a
public reason, never an offer, hour, or price. That group is Lee's Pint & Shell,
Walt's Inn, Bo Brooks, Sports Balls, Baltimore Tap House, The Worthington, SoPro,
Honeypot, and El Bufalo. `notes_public` is the reason text; `ops_notes` never
renders.

### Holding back a single deal row

A venue can be fine while one of its deals isn't — a happy hour whose days the
venue never actually published, or an offer whose hours two official sources
disagree about. Put `"status": "held"` on that deal row:

```json
{ "days": ["mon"], "items": ["Happy hour all day"], "status": "held" }
```

Held rows never render, on any day or any path. The row stays in the file so the
research isn't lost, and it starts rendering the moment you delete the status.
Omitting `status` means the deal renders — that is the normal case.

Deal rows are validated strictly: `days`, `items`, `time_window`, `start`,
`end`, `prices_published`, `status`, optional `source_url`, and nothing else.
`status` may only be `"held"`. Inventing your own hold field (`"verified": false`,
`"hold": true`) fails the suite rather than being ignored and rendering the deal
anyway.

Optional deal `source_url` is the URL that **verified that row**. When present,
the card's "source" link uses it instead of the venue homepage — so Mama's brunch
links to Instagram, not the website that never mentions the deal.

A venue whose deals are *all* held simply shows no deals. It keeps its entry and
its notes.

### Required vs optional fields

Always required: `id`, `name`, `neighborhood`, `status`, `deals` (an array).

Required only when `status` is `verified`: `source_type`, `last_verified`
(`YYYY-MM-DD`), and at least one deal. A venue that renders with no deals fails
the suite.

Optional everywhere: `address`, `phone`, `source_url`, `notes_public`,
`ops_notes`, `bar_hours`, `lat`/`lon` + `coords_source`. Coordinates are
geocoded from verified street addresses via OpenStreetMap Nominatim — **not**
venue-published — and the provenance string is required whenever lat/lon are set.
Sports Balls has no coordinates in the research table, so it omits them. Several
real venues have no phone or source URL published anywhere we're allowed to
read, so the renderer drops whichever line is missing rather than failing.

`npm test` validates every entry, so a malformed venue fails the suite instead
of silently vanishing from the board.

## Neighborhood views

[`data/views.json`](data/views.json) defines the boards. A view is a slug, a
label, and the neighborhoods it covers — one view can span several:

```json
{ "slug": "canton", "label": "Canton", "neighborhoods": ["Canton", "Brewers Hill"] }
```

`/canton` renders that board and the title reads "Tonight in Canton". `/`
redirects to the first view. Add a second view and a switcher appears in the
header automatically. Venues keep their own true `neighborhood` either way, and
no neighborhood name is hard-coded in the source — a test enforces that.

## What "today" means

The board shows the current day in **America/New_York**, not the server's
clock — a Friday 11pm and a Saturday 1am are different boards. See
`src/deals.js`.
