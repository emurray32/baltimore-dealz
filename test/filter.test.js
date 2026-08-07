import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { dealsForDay, venuesInView } from "../src/deals.js";
import { foodFilterBar, cardsHtmlForDay, renderBoard } from "../src/page.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAT = new Date("2026-08-08T16:00:00Z"); // Sat

test("Claddagh Saturday card carries wings and sandwich food categories", async () => {
  const venues = venuesInView(await loadVenues(), (await loadViews()).find((v) => v.slug === "canton"));
  const html = cardsHtmlForDay(venues, "sat", SAT);
  const blocks = html.split("<article").filter((b) => b.includes("Claddagh") && b.includes("Wings"));
  assert.ok(blocks.length >= 1, "expected Claddagh wings card");
  const food = blocks[0].match(/data-food="([^"]+)"/);
  assert.ok(food, "data-food missing");
  const cats = food[1].split(/\s+/);
  assert.ok(cats.includes("wings"), food[1]);
  assert.ok(cats.includes("sandwich/cheesesteak"), food[1]);
});

test("food filter bar lists Wings and Sandwiches when both exist on board", async () => {
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const bar = foodFilterBar(venuesInView(await loadVenues(), canton));
  assert.match(bar, /data-filter="wings"/);
  assert.match(bar, /data-filter="sandwich\/cheesesteak"/);
  assert.match(bar, /id="food-filter"/);
  assert.match(bar, /id="filter-status"/);
});

test("proof_quote renders on cards and never invents paraphrase", async () => {
  const views = await loadViews();
  const canton = views.find((v) => v.slug === "canton");
  const html = renderBoard(venuesInView(await loadVenues(), canton), canton, views, SAT);
  assert.match(html, /class="proof"/);
  assert.match(html, /MONDAY — ALL NIGHT HAPPY HOUR/);
  assert.match(html, /client-filter\.js/);
});

test("client-filter empty selection says so in words", async () => {
  const src = await readFile(join(ROOT, "public", "client-filter.js"), "utf8");
  // Minimal DOM: one card that does not match "wings"
  function el(tag, attrs = {}) {
    const n = {
      tagName: tag.toUpperCase(),
      className: attrs.className || "",
      classList: {
        _s: new Set((attrs.className || "").split(/\s+/).filter(Boolean)),
        add(c) { this._s.add(c); n.className = [...this._s].join(" "); },
        remove(c) { this._s.delete(c); n.className = [...this._s].join(" "); },
        contains(c) { return this._s.has(c); },
      },
      id: attrs.id || "",
      attributes: { ...(attrs.attrs || {}) },
      children: attrs.children || [],
      textContent: "",
      getAttribute(k) { return this.attributes[k] ?? null; },
      setAttribute(k, v) { this.attributes[k] = v; },
      querySelectorAll(sel) {
        if (sel === ".filter-btn") return this.children.filter((c) => c.classList.contains("filter-btn"));
        if (sel === "article.card") return this._cards || [];
        return [];
      },
      querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
      },
      addEventListener(type, fn) {
        this._l = this._l || {};
        (this._l[type] = this._l[type] || []).push(fn);
      },
      click() {
        for (const fn of (this._l && this._l.click) || []) fn.call(this);
      },
    };
    return n;
  }

  const drinkBtn = el("button", { className: "filter-btn", attrs: { "data-filter": "drink" } });
  const allBtn = el("button", { className: "filter-btn is-on", attrs: { "data-filter": "" } });
  const status = el("p", { id: "filter-status", className: "filter-status meta" });
  const bar = el("section", { id: "food-filter" });
  bar.children = [allBtn, drinkBtn];
  allBtn.classList.add("is-on");

  const card = el("article", { className: "card", attrs: { "data-food": "wings sandwich/cheesesteak" } });
  const document = {
    getElementById(id) {
      if (id === "food-filter") return bar;
      if (id === "filter-status") return status;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === ".card[data-food]") return [card];
      if (sel === ".timing-group") return [];
      return [];
    },
  };
  bar.querySelectorAll = (sel) => {
    if (sel === ".filter-btn") return [allBtn, drinkBtn];
    return [];
  };

  vm.runInNewContext(src, { document, console }, { filename: "client-filter.js" });
  drinkBtn.click();
  assert.equal(status.textContent, "No deals match that filter.");
  assert.ok(card.classList.contains("filter-hide"));
});
