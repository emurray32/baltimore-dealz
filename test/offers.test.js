// Deal-vs-menu ranking. Eric, 2026-08-10: "this is more of a menu, not a set of
// deals... If it's $4 drafts, that's a deal, but simply naming things and giving
// prices isn't what we're going for."
//
// A card leads with lines a customer can judge — the venue stated the saving, or
// the number is plainly cheap — and collapses the rest. Nothing is deleted.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CARD_OFFER_LIMIT,
  isJudgeableOffer,
  JUDGEABLE_MAX_PRICE,
  offerRank,
  rankOffers,
  splitOffers,
} from "../src/deals.js";
import { cardsHtmlForDay, escapeHtml } from "../src/page.js";
import { renderVenuePage, venueScheduleByDay } from "../src/venue.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";

const FRI_4PM_EDT = new Date("2026-08-07T20:00:00Z");

test("stated savings rank above any price; plain prices sort cheapest first", () => {
  assert.deepEqual(offerRank({ text: "$2 Off Sandwiches", price: "$2 off" }), [0, 0]);
  assert.deepEqual(offerRank({ text: "1/2 Off Mussels", price: "1/2 off" }), [0, 0]);
  assert.deepEqual(offerRank({ text: "BOGO Sushi Rolls", price: "BOGO" }), [0, 0]);
  assert.deepEqual(offerRank({ text: "2 for 1 Crushes", price: "2 for 1" }), [0, 0]);

  assert.deepEqual(offerRank({ text: "Draft Beer $6", price: "$6" }), [1, 6]);
  assert.deepEqual(offerRank({ text: "Oysters $2.50 each", price: "$2.50" }), [1, 2.5]);
  // A range sorts on its low end — the cheapest way in.
  assert.deepEqual(offerRank({ text: "Wine $7.50–$12", price: "$7.50–$12" }), [1, 7.5]);

  // No readable price at all sorts last, never in the middle.
  assert.deepEqual(offerRank({ text: "Trivia Night" }), [2, 0]);
});

test("REGRESSION: '1/2 Lb.' is a portion size, not half price", () => {
  // This exact line once got promoted to the top of Loch Bar's card as a
  // half-price deal. Ranking reads the structured price field, not the prose.
  const shrimp = { text: "1/2 Lb. Peel & Eat Shrimp $16", price: "$16" };
  assert.deepEqual(offerRank(shrimp), [1, 16]);
  assert.equal(isJudgeableOffer(shrimp), false, "a $16 menu line is not a judgeable deal");
});

test("a saving stated only in the item's words still ranks first", () => {
  // These carry no price field, but they are the clearest deals on the board.
  for (const text of [
    "Free street taco with order of two",
    "Kids eat free after 5 (restrictions apply)",
    "Half Off Select Wine Bottles",
    "$3 off wine glasses",
  ]) {
    assert.deepEqual(offerRank({ text }), [0, 0], `should be a stated saving: ${text}`);
  }
});

test("an amount is never parsed out of free text — a prize is not a price", () => {
  // "win a $50 gift card" must not become a $50 offer.
  assert.deepEqual(offerRank({ text: "Bmore Trivia — win a $50 gift card" }), [2, 0]);
});

test("rankOffers is stable within a tier and keeps every line", () => {
  const items = [
    { text: "Steak $27", price: "$27" },
    { text: "Fries $5", price: "$5" },
    { text: "Trivia" },
    { text: "$2 Off Burgers", price: "$2 off" },
    { text: "Soup $5", price: "$5" },
    { text: "Karaoke" },
  ];
  const ranked = rankOffers(items);
  assert.deepEqual(
    ranked.map((i) => i.text),
    ["$2 Off Burgers", "Fries $5", "Soup $5", "Steak $27", "Trivia", "Karaoke"],
  );
  assert.equal(ranked.length, items.length);
});

test("splitOffers caps the card and keeps unjudgeable prices out of the lead", () => {
  const items = [
    { text: "Oysters $2.50", price: "$2.50" },
    { text: "Hushpuppies $5", price: "$5" },
    { text: "Fries $5", price: "$5" },
    { text: "Crab Soup $6", price: "$6" },
    { text: "Draft Beer $6", price: "$6" },
    { text: "Fried Oysters $6", price: "$6" },
    { text: "Caesar $7", price: "$7" },
    { text: "Shrimp Cocktail $14", price: "$14" },
    { text: "1/2 Lb. Peel & Eat Shrimp $16", price: "$16" },
  ];
  const { shown, rest } = splitOffers(items);
  assert.equal(shown.length, CARD_OFFER_LIMIT);
  assert.equal(shown.length + rest.length, items.length, "no line may be dropped");

  // The two above the ceiling are not on the face of the card.
  const shownText = shown.map((i) => i.text).join(" | ");
  assert.doesNotMatch(shownText, /\$14|\$16/);
  assert.match(rest.map((i) => i.text).join(" | "), /\$14/);
});

test("a card whose every line is expensive still shows its cheapest few", () => {
  // Claddagh's steak-night row: nothing is cheap, but the tile must not be bare.
  const items = [
    { text: "2 Giant Crab Cakes $37", price: "$37" },
    { text: "8oz Filet Mignon $27", price: "$27" },
    { text: "14oz New York Strip $25", price: "$25" },
    { text: "Fish & Chips $15", price: "$15" },
  ];
  const { shown, rest } = splitOffers(items);
  assert.ok(shown.length > 0, "a card must never render empty");
  assert.equal(shown[0].text, "Fish & Chips $15", "cheapest still leads");
  assert.equal(shown.length + rest.length, items.length);
});

test("the ceiling exempts stated savings at any price", () => {
  assert.ok(JUDGEABLE_MAX_PRICE > 0);
  assert.equal(isJudgeableOffer({ text: "$40 bottle, 1/2 off", price: "1/2 off" }), true);
  assert.equal(isJudgeableOffer({ text: "Draft $4", price: "$4" }), true);
  assert.equal(isJudgeableOffer({ text: "Entree $25", price: "$25" }), false);
});

test("board: Loch Bar leads with cheap lines and collapses the rest — nothing lost", async () => {
  const venues = await loadVenues();
  const loch = venues.find((v) => v.id === "loch-bar");
  assert.ok(loch, "Loch Bar must still be on the board");
  const deal = loch.deals.find((d) => d.days.includes("fri"));
  assert.ok(deal && deal.items.length > CARD_OFFER_LIMIT, "fixture needs a long list");

  const views = await loadViews();
  const html = cardsHtmlForDay(venues, "fri", FRI_4PM_EDT, {
    venueHref: (id) => `/venue/${id}`,
  });

  // The disclosure exists and is honest about the count.
  const hidden = deal.items.length - CARD_OFFER_LIMIT;
  assert.match(html, /<details class="more-offers">/);
  assert.match(html, new RegExp(`\\+${hidden} more`));

  // Every single line still ships in the document — search and filters see them.
  for (const item of deal.items) {
    assert.ok(
      html.includes(escapeHtml(item.text)),
      `line must still be in the document: ${item.text}`,
    );
  }

  // The expensive menu lines are behind the disclosure, not on the face.
  const face = html.slice(0, html.indexOf('<details class="more-offers">'));
  assert.doesNotMatch(face, /1\/2 Lb\. Peel &amp; Eat Shrimp \$16/);
  assert.match(html, /Local Oysters - Loch Bar Salts \$2\.50 each/);
  assert.ok(views.length > 0);
});

test("board: no card shows more than the cap on any day of the week", async () => {
  const venues = await loadVenues();
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    const html = cardsHtmlForDay(venues, day, FRI_4PM_EDT);
    // Count <li> that sit outside a <details> — the face of every card.
    const faces = html.split('<details class="more-offers">');
    for (let i = 0; i < faces.length; i += 1) {
      // Everything after the first chunk starts inside a disclosure; cut at </details>.
      const chunk = i === 0 ? faces[i] : faces[i].slice(faces[i].indexOf("</details>") + 10);
      for (const list of chunk.match(/<ul>[\s\S]*?<\/ul>/g) ?? []) {
        const count = (list.match(/<li>/g) ?? []).length;
        assert.ok(
          count <= CARD_OFFER_LIMIT,
          `${day}: a card face showed ${count} lines, cap is ${CARD_OFFER_LIMIT}`,
        );
      }
    }
  }
});

test("venue page shows the whole list and never collapses it", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  const loch = venues.find((v) => v.id === "loch-bar");
  const html = renderVenuePage(loch, views, FRI_4PM_EDT);

  // No truncation on the detail page — it is where the full list belongs.
  assert.doesNotMatch(html, /more-offers/);
  for (const item of loch.deals[0].items) {
    assert.ok(html.includes(escapeHtml(item.text)), `venue page must list ${item.text}`);
  }
  assert.ok(venueScheduleByDay(loch).length > 0);
});

test("venue page reorders the venue's own list to lead with the cheap end", async () => {
  const venues = await loadVenues();
  const views = await loadViews();
  // Liv's publishes "All HH Food $7..." first and "$4 Drafts" further down.
  // Picked precisely because ranking is NOT a no-op here — Loch Bar's list
  // already happens to open with its cheapest line, so it cannot detect this.
  const livs = venues.find((v) => v.id === "livs-tavern");
  assert.ok(livs, "fixture venue missing");
  const deal = livs.deals[0];
  const ranked = rankOffers(deal.items);
  assert.notEqual(ranked[0], deal.items[0], "fixture must actually reorder");

  const html = renderVenuePage(livs, views, FRI_4PM_EDT);
  const posOf = (item) => html.indexOf(escapeHtml(item.text));
  assert.ok(posOf(ranked[0]) > -1, "ranked-first line must render");
  assert.ok(
    posOf(ranked[0]) < posOf(deal.items[0]),
    `${ranked[0].text} should render before ${deal.items[0].text}`,
  );
});

test("style.css ships the disclosure so the collapsed rows are reachable", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const css = await readFile(`${root}public/style.css`, "utf8");
  assert.match(css, /\.more-offers\s*>\s*summary/);
  assert.match(css, /cursor:\s*pointer/);
});
