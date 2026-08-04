# Baltimore Dealz

Tonight in Canton — a board of Baltimore bar and restaurant specials.

## Run it

```bash
npm start
```

Then open http://localhost:3000. No install step, no database, no accounts —
plain Node (v20+), zero dependencies.

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

`days` uses `mon tue wed thu fri sat sun`. `time_window` is optional and is
free text as the venue words it. Adding a venue means adding one object to
that array — nothing else changes. The file is re-read on every request, so a
crawler can rewrite it in place without a restart.

`npm test` validates the shape of every entry, so a malformed venue fails the
suite instead of silently vanishing from the board.

## What "today" means

The board shows the current day in **America/New_York**, not the server's
clock — a Friday 11pm and a Saturday 1am are different boards. See
`src/deals.js`.
