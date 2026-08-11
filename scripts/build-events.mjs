// Regenerates data/events.json from official schedule sources.
//
// Events are NOT deals. A Ravens game is a date, not a price — it goes on the
// calendar as an event. It only becomes a *deal* when a specific venue
// publishes a specific watch-party offer we can cite, and that lives in
// venues.json like every other deal.
//
// Run: node scripts/build-events.mjs
//
// Both sources are the leagues' own, not aggregators:
//   Ravens  — schema.org SportsEvent JSON-LD embedded in baltimoreravens.com/schedule/
//   Orioles — statsapi.mlb.com, MLB's own public schedule API (no key)

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../data/events.json", import.meta.url));

const RAVENS_URL = "https://www.baltimoreravens.com/schedule/";
const ORIOLES_API =
  "https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=110&startDate=2026-01-01&endDate=2026-12-31";
const ORIOLES_CITE = "https://www.mlb.com/orioles/schedule";

const BALTIMORE_TZ = "America/New_York";

// Split a UTC instant into Baltimore-local date + time. Both feeds publish UTC,
// and the Ravens one omits the "Z" — the 8:15pm Thursday night game arrives as
// "2026-11-06T01:15:00" and lands on the wrong calendar day if read naively.
function toBaltimore(utcIso) {
  const withZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(utcIso) ? utcIso : `${utcIso}Z`;
  const d = new Date(withZone);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BALTIMORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${hour}:${get("minute")}` };
}

async function ravensHomeGames() {
  const res = await fetch(RAVENS_URL, { headers: { "user-agent": "baltimore-dealz/0.1" } });
  if (!res.ok) throw new Error(`Ravens schedule HTTP ${res.status}`);
  const html = await res.text();

  const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
  const events = [];
  let skippedNoDate = 0;

  for (const [, raw] of blocks) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (data["@type"] !== "SportsEvent") continue;
    if (data.homeTeam?.name !== "Baltimore Ravens") continue;
    // Flex-scheduled games publish no kickoff yet. Dropping them is right —
    // inventing a date would put a wrong game on the calendar.
    if (!data.startDate) {
      skippedNoDate += 1;
      continue;
    }
    const local = toBaltimore(data.startDate);
    if (!local) {
      skippedNoDate += 1;
      continue;
    }
    const slug = String(data["@id"] ?? "").split("/").pop() || `ravens-${local.date}`;
    events.push({
      id: `ravens-${slug}`,
      title: `Ravens vs ${data.awayTeam?.name ?? "TBD"}`,
      date: local.date,
      time: local.time,
      place: data.location?.name ?? "M&T Bank Stadium",
      category: "sports",
      source_url: RAVENS_URL,
    });
  }
  return { events, skippedNoDate };
}

async function oriolesHomeGames() {
  const res = await fetch(ORIOLES_API, { headers: { "user-agent": "baltimore-dealz/0.1" } });
  if (!res.ok) throw new Error(`MLB schedule HTTP ${res.status}`);
  const data = await res.json();

  const events = [];
  let skippedNoDate = 0;
  let skippedAwayFromBaltimore = 0;
  for (const day of data.dates ?? []) {
    for (const game of day.games ?? []) {
      if (game.teams?.home?.team?.id !== 110) continue;
      // "Home" in MLB's data includes spring training at Ed Smith Stadium in
      // Sarasota. This is a Baltimore board — a game in Florida is not
      // something a Canton bar's customer can walk to.
      if (game.venue?.name !== "Oriole Park at Camden Yards") {
        skippedAwayFromBaltimore += 1;
        continue;
      }
      if (!game.gameDate) {
        skippedNoDate += 1;
        continue;
      }
      const local = toBaltimore(game.gameDate);
      if (!local) {
        skippedNoDate += 1;
        continue;
      }
      events.push({
        id: `orioles-${game.gamePk}`,
        title: `Orioles vs ${game.teams?.away?.team?.name ?? "TBD"}`,
        date: local.date,
        time: local.time,
        place: game.venue?.name ?? "Oriole Park at Camden Yards",
        category: "sports",
        source_url: ORIOLES_CITE,
      });
    }
  }
  return { events, skippedNoDate, skippedAwayFromBaltimore };
}

const [ravens, orioles] = await Promise.all([ravensHomeGames(), oriolesHomeGames()]);

const events = [...ravens.events, ...orioles.events].sort(
  (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id),
);

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: BALTIMORE_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

await writeFile(
  OUT,
  `${JSON.stringify(
    {
      schema_version: 1,
      generated: today,
      derived_from: [RAVENS_URL, ORIOLES_CITE],
      events,
    },
    null,
    2,
  )}\n`,
);

// Never let a bounded run read as full coverage — say what was dropped.
console.log(`Ravens home games: ${ravens.events.length} (skipped, no kickoff time yet: ${ravens.skippedNoDate})`);
console.log(`Orioles home games at Camden Yards: ${orioles.events.length} (skipped, not in Baltimore: ${orioles.skippedAwayFromBaltimore}; no date: ${orioles.skippedNoDate})`);
console.log(`Wrote ${events.length} events to data/events.json`);
