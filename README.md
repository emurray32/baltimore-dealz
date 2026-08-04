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

### status — what shows up and what doesn't

| status | Renders? | Use it for |
|---|---|---|
| `verified` | yes | We have a deal from an official source |
| `open_unverifiable` | **never** | The place is open, but no deal we can honestly publish |

Unverified venues stay in the file so the research isn't lost, but the board
filters them out in code — not by leaving rows out of the file. Claddagh Pub
(domain repurposed, no published deals) and Lee's Pint & Shell (its promo is
monthly, and this model is weekly-only) both sit here.

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

Deal rows are validated strictly: `days`, `items`, `time_window`, `status` and
nothing else, and `status` may only be `"held"`. Inventing your own hold field
(`"verified": false`, `"hold": true`) fails the suite rather than being ignored
and rendering the deal anyway.

A venue whose deals are *all* held simply shows no deals. It keeps its entry and
its notes.

### Required vs optional fields

Always required: `id`, `name`, `neighborhood`, `status`, `deals` (an array).

Required only when `status` is `verified`: `source_type`, `last_verified`
(`YYYY-MM-DD`), and at least one deal. A venue that renders with no deals fails
the suite.

Optional everywhere: `address`, `phone`, `source_url`, `notes`. Several real
venues have no phone or source URL published anywhere we're allowed to read, so
the renderer drops whichever line is missing rather than failing.

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
