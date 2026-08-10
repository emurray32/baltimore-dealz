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
  assert.doesNotMatch(html, /MONDAY — ALL NIGHT HAPPY HOUR/);
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
      closest(sel) { return null; },
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

// --- B2: filter status count matches chip count (one shared counting rule) --

test("B2: filter status reads count from chip, not DOM — shared counting rule", async () => {
  const src = await readFile(join(ROOT, "public", "client-filter.js"), "utf8");

  // The filter status message must read its number from the clicked chip's
  // .filter-count span — the same number the server baked into the button.
  // Chip and status share one counting rule (dealsForDay over the week) so
  // they literally cannot drift apart. Even if the DOM carries duplicate
  // cards (tonight-board copies), the status echoes the chip, not the DOM.

  function el(tag, attrs = {}, children = []) {
    var n = {
      tagName: tag.toUpperCase(),
      className: attrs.className || "",
      id: attrs.id || "",
      children: children,
      parentElement: attrs.parentElement || null,
      textContent: attrs.textContent || "",
      attributes: { ...(attrs.attrs || {}) },
    };
    n._classes = new Set((attrs.className || "").split(/\s+/).filter(Boolean));
    n.classList = {
      _s: n._classes,
      add: function (c) { this._s.add(c); n.className = [...this._s].join(" "); },
      remove: function (c) { this._s.delete(c); n.className = [...this._s].join(" "); },
      contains: function (c) { return this._s.has(c); },
    };
    n.getAttribute = function (k) { return this.attributes[k] ?? null; };
    n.setAttribute = function (k, v) { this.attributes[k] = v; };
    n.querySelectorAll = function (sel) {
      if (sel === ".filter-btn") return this.children.filter(function (c) { return c._classes.has("filter-btn"); });
      if (sel === ".filter-count") return this.children.filter(function (c) { return c._classes.has("filter-count"); });
      if (sel === "article.card") return n._cards || [];
      if (sel === ".timing-group") return [];
      return [];
    };
    n.querySelector = function (sel) {
      return this.querySelectorAll(sel)[0] || null;
    };
    n.addEventListener = function (type, fn) {
      n._l = n._l || {};
      (n._l[type] = n._l[type] || []).push(fn);
    };
    n.click = function () {
      for (var i = 0; i < ((n._l && n._l.click) || []).length; i++) {
        (n._l.click)[i].call(n);
      }
    };
    return n;
  }

  // Two wings cards: one in tonight-board, one in week accordion (Sunday).
  // The chip says "2" (all-week count); the status must say "2" even though
  // tonight-board creates a DOM duplicate of today's card.
  var tonightWings = el("article", { className: "card", attrs: { "data-food": "wings" } });
  var sunWings = el("article", { className: "card", attrs: { "data-food": "wings" } });

  var tonightBoard = el("section", { id: "tonight-board" });
  tonightWings.parentElement = tonightBoard;
  tonightBoard.children = [tonightWings];

  // Chip: "Wings 2" — the filter-count span carries the server's number.
  var countSpan = el("span", { className: "filter-count", textContent: "2" });
  var wingsBtn = el("button", { className: "filter-btn", attrs: { "data-filter": "wings" } }, [countSpan]);
  var allBtn = el("button", { className: "filter-btn is-on", attrs: { "data-filter": "" } });
  allBtn.classList._s.add("is-on");
  var status = el("p", { id: "filter-status", className: "filter-status meta" });
  var bar = el("section", { id: "food-filter" });
  bar.children = [allBtn, wingsBtn];

  var allCards = [tonightWings, sunWings];
  var document = {
    getElementById: function (id) {
      if (id === "food-filter") return bar;
      if (id === "filter-status") return status;
      if (id === "tonight-board") return tonightBoard;
      return null;
    },
    querySelectorAll: function (sel) {
      if (sel === ".card[data-food]") return allCards;
      if (sel === ".timing-group") return [];
      return [];
    },
  };
  bar.querySelectorAll = function (sel) {
    if (sel === ".filter-btn") return [allBtn, wingsBtn];
    return [];
  };

  vm.runInNewContext(src, { document, console }, { filename: "client-filter.js" });

  // Click wings filter: status reads "2" from the chip, matching the all-week
  // count. Both cards remain visible (they match "wings").
  wingsBtn.click();
  assert.equal(status.textContent, "2 deals match that filter on this board.");
  assert.ok(!tonightWings.classList.contains("filter-hide"));
  assert.ok(!sunWings.classList.contains("filter-hide"));
});

test("B2 mutation: chip count and status count cannot disagree", async () => {
  // If someone patches the client-filter to count DOM cards instead of reading
  // from the chip, this test catches it.  We set up tonight-board duplicates
  // so a DOM count would give 3 while the chip says 2.
  const src = await readFile(join(ROOT, "public", "client-filter.js"), "utf8");

  function el(tag, attrs = {}, children = []) {
    var n = {
      tagName: tag.toUpperCase(),
      className: attrs.className || "",
      id: attrs.id || "",
      children: children,
      parentElement: attrs.parentElement || null,
      textContent: attrs.textContent || "",
      attributes: { ...(attrs.attrs || {}) },
    };
    n._classes = new Set((attrs.className || "").split(/\s+/).filter(Boolean));
    n.classList = {
      _s: n._classes,
      add: function (c) { this._s.add(c); n.className = [...this._s].join(" "); },
      remove: function (c) { this._s.delete(c); n.className = [...this._s].join(" "); },
      contains: function (c) { return this._s.has(c); },
    };
    n.getAttribute = function (k) { return this.attributes[k] ?? null; };
    n.setAttribute = function (k, v) { this.attributes[k] = v; };
    n.querySelectorAll = function (sel) {
      if (sel === ".filter-btn") return this.children.filter(function (c) { return c._classes.has("filter-btn"); });
      if (sel === ".filter-count") return this.children.filter(function (c) { return c._classes.has("filter-count"); });
      if (sel === "article.card") return n._cards || [];
      if (sel === ".timing-group") return [];
      return [];
    };
    n.querySelector = function (sel) {
      return this.querySelectorAll(sel)[0] || null;
    };
    n.addEventListener = function (type, fn) {
      n._l = n._l || {};
      (n._l[type] = n._l[type] || []).push(fn);
    };
    n.click = function () {
      for (var i = 0; i < ((n._l && n._l.click) || []).length; i++) {
        (n._l.click)[i].call(n);
      }
    };
    return n;
  }

  // Three wings cards: two tonight duplicates + one week-accordion.
  // Chip says 2; DOM count would say 3.
  var tonightA = el("article", { className: "card", attrs: { "data-food": "wings" } });
  var tonightB = el("article", { className: "card", attrs: { "data-food": "wings" } });
  var sunWings = el("article", { className: "card", attrs: { "data-food": "wings" } });

  var tonightBoard = el("section", { id: "tonight-board" });
  tonightA.parentElement = tonightBoard;
  tonightB.parentElement = tonightBoard;
  tonightBoard.children = [tonightA, tonightB];

  var countSpan = el("span", { className: "filter-count", textContent: "2" });
  var wingsBtn = el("button", { className: "filter-btn", attrs: { "data-filter": "wings" } }, [countSpan]);
  var allBtn = el("button", { className: "filter-btn is-on", attrs: { "data-filter": "" } });
  allBtn.classList._s.add("is-on");
  var status = el("p", { id: "filter-status", className: "filter-status meta" });
  var bar = el("section", { id: "food-filter" });
  bar.children = [allBtn, wingsBtn];

  var allCards = [tonightA, tonightB, sunWings];
  var document = {
    getElementById: function (id) {
      if (id === "food-filter") return bar;
      if (id === "filter-status") return status;
      if (id === "tonight-board") return tonightBoard;
      return null;
    },
    querySelectorAll: function (sel) {
      if (sel === ".card[data-food]") return allCards;
      if (sel === ".timing-group") return [];
      return [];
    },
  };
  bar.querySelectorAll = function (sel) {
    if (sel === ".filter-btn") return [allBtn, wingsBtn];
    return [];
  };

  vm.runInNewContext(src, { document, console }, { filename: "client-filter.js" });
  wingsBtn.click();
  // If someone reverts to DOM counting, they'd get 3 (or try to de-dupe
  // tonight → 1). The chip says 2. This must hold.
  assert.equal(status.textContent, "2 deals match that filter on this board.");
});
