# Baltimore Dealz

A board of Baltimore bar and restaurant specials — what's on tonight, by neighborhood.

## How to run

The workflow **"Start application"** is configured. It runs:

```
PORT=5000 npm start
```

No install step needed — zero npm dependencies, plain Node.js (v20+).

## How to test

```bash
npm test
```

## Project structure

- `server.js` — HTTP server entry point
- `src/` — Deal filtering, HTML rendering, venue/view loaders
- `data/venues.json` — All venue and deal data (re-read on every request, no restart needed)
- `data/views.json` — Neighborhood board definitions
- `public/style.css` — Stylesheet
- `test/` — Node built-in test suite

## Adding venues / deals

Edit `data/venues.json` — changes are picked up live without restarting the server. Run `npm test` after any edit to validate the data.

## User preferences

(none yet)
