// Board search: client-side substring filter. No venues.json.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { renderBoard } from "../src/page.js";
import { venuesInView } from "../src/deals.js";
import { loadVenues } from "../src/venues.js";
import { loadViews } from "../src/views.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRI_11PM_EDT = new Date("2026-08-08T03:00:00Z");

test("renderBoard ships client-search.js and no search markup without the script", async () => {
  const views = await loadViews();
  const view = views.find((v) => v.slug === "canton") ?? views[0];
  const html = renderBoard(
    venuesInView(await loadVenues(), view),
    view,
    views,
    FRI_11PM_EDT,
  );
  assert.match(html, /client-search\.js/);
  // Search box is injected by the script — not in the pre-rendered HTML.
  assert.doesNotMatch(html, /id="board-search"/);
  assert.doesNotMatch(html, /class="board-search"/);
});

test("client-search filters cards within timing groups and reports empty results", async () => {
  // Minimal DOM so the IIFE can run without a browser.
  const src = await readFile(join(ROOT, "public", "client-search.js"), "utf8");

  function el(tag, attrs = {}, kids = []) {
    const node = {
      tagName: tag.toUpperCase(),
      className: attrs.className || "",
      classList: {
        contains(c) {
          return (node.className || "").split(/\s+/).includes(c);
        },
      },
      id: attrs.id || "",
      hidden: false,
      textContent: attrs.textContent || "",
      innerHTML: "",
      children: [],
      childNodes: [],
      parentNode: null,
      nextSibling: null,
      style: {},
      attributes: {},
      setAttribute(k, v) {
        node.attributes[k] = v;
      },
      getAttribute(k) {
        return node.attributes[k];
      },
      querySelector(sel) {
        return queryAll(node, sel)[0] || null;
      },
      querySelectorAll(sel) {
        return queryAll(node, sel);
      },
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        node.childNodes.push(child);
        return child;
      },
      insertBefore(child, ref) {
        child.parentNode = node;
        if (!ref) return node.appendChild(child);
        const i = node.children.indexOf(ref);
        node.children.splice(i, 0, child);
        node.childNodes = node.children.slice();
        return child;
      },
      addEventListener(type, fn) {
        node._listeners = node._listeners || {};
        node._listeners[type] = node._listeners[type] || [];
        node._listeners[type].push(fn);
      },
      dispatch(type) {
        for (const fn of (node._listeners && node._listeners[type]) || []) fn();
      },
    };
    for (const k of kids) node.appendChild(k);
    return node;
  }

  function queryAll(root, sel) {
    const out = [];
    function walk(n) {
      if (!n || !n.tagName) return;
      if (match(n, sel)) out.push(n);
      for (const c of n.children || []) walk(c);
    }
    walk(root);
    return out;
  }

  function match(n, sel) {
    if (sel === "article.card") return n.tagName === "ARTICLE" && n.classList.contains("card");
    if (sel === ".timing-group") return n.classList.contains("timing-group");
    if (sel === ".quiet-list > li") return n.tagName === "LI" && n.parentNode && n.parentNode.classList.contains("quiet-list");
    if (sel === "section.quiet") return n.tagName === "SECTION" && n.classList.contains("quiet");
    if (sel === "details") return n.tagName === "DETAILS";
    if (sel === "h2") return n.tagName === "H2";
    if (sel === ".nearest-row") return n.classList.contains("nearest-row");
    if (sel === "main > section details article.card") {
      return n.tagName === "ARTICLE" && n.classList.contains("card") && n._inWeek;
    }
    if (sel === ":scope > article.card") {
      // Only used on board for ungrouped cards — none in our fixture.
      return false;
    }
    if (sel.startsWith("#")) return n.id === sel.slice(1);
    return false;
  }

  const claddagh = el("article", { className: "card", textContent: "Claddagh Pub 4pm-7pm Happy Hour" });
  const mahaffeys = el("article", { className: "card", textContent: "Mahaffey's Pub Sliders" });
  const host = el("div", { className: "timing-cards" }, [claddagh, mahaffeys]);
  const group = el("div", { className: "timing-group" }, [
    el("h3", { className: "timing-heading", textContent: "On now" }),
    host,
  ]);
  // re-parent cards under host properly
  host.children = [claddagh, mahaffeys];
  claddagh.parentNode = host;
  mahaffeys.parentNode = host;

  const barracudas = el("li", { textContent: "Barracudas Locust Point — no prices" });
  const quietList = el("ul", { className: "quiet-list" }, [barracudas]);
  barracudas.parentNode = quietList;
  quietList.classList = {
    contains(c) {
      return c === "quiet-list";
    },
  };
  const quiet = el("section", { className: "quiet" }, [
    el("details", {}, [quietList]),
  ]);
  // fix classList on quiet/section
  quiet.className = "quiet";
  quiet.classList = {
    contains(c) {
      return c === "quiet";
    },
  };

  const board = el("section", { id: "tonight-board" }, [
    el("h2", { textContent: "On tonight" }),
    el("p", { className: "nearest-row" }),
    group,
  ]);
  board.id = "tonight-board";
  group.parentNode = board;

  // Fix group classList
  group.className = "timing-group";
  group.classList = {
    contains(c) {
      return c === "timing-group";
    },
  };
  group.querySelectorAll = (sel) => {
    if (sel === "article.card") return [claddagh, mahaffeys];
    return [];
  };

  const main = el("main", {}, [board, quiet]);
  board.parentNode = main;

  // document mock
  const created = [];
  const document = {
    getElementById(id) {
      if (id === "tonight-board") return board;
      if (id === "board-search") return created.find((n) => n.id === "board-search") || null;
      return null;
    },
    querySelector(sel) {
      if (sel === "section.quiet") return quiet;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "main > section details article.card") return [];
      return [];
    },
    createElement(tag) {
      const node = el(tag);
      // className setter
      Object.defineProperty(node, "className", {
        get() {
          return node._cn || "";
        },
        set(v) {
          node._cn = v;
          node.classList = {
            contains(c) {
              return (node._cn || "").split(/\s+/).includes(c);
            },
          };
        },
      });
      Object.defineProperty(node, "innerHTML", {
        get() {
          return node._html || "";
        },
        set(html) {
          node._html = html;
          // crude parse for input#board-search
          if (html.includes('id="board-search"')) {
            const input = el("input");
            input.id = "board-search";
            input.value = "";
            input.tagName = "INPUT";
            created.push(input);
            // when row gets innerHTML, expose input via getElementById
            node.querySelector = (s) => (s === "input" || s === "#board-search" ? input : null);
          }
        },
      });
      created.push(node);
      return node;
    },
  };

  // Patch board.querySelectorAll for timing groups
  board.querySelectorAll = (sel) => {
    if (sel === ".timing-group") return [group];
    if (sel === ":scope > article.card") return [];
    if (sel === "h2") return [board.children[0]];
    if (sel === ".nearest-row") return [board.children[1]];
    return [];
  };
  board.querySelector = (sel) => board.querySelectorAll(sel)[0] || null;

  quiet.querySelectorAll = (sel) => {
    if (sel === ".quiet-list > li") return [barracudas];
    if (sel === "details") return [quiet.children[0]];
    return [];
  };
  quiet.querySelector = (sel) => quiet.querySelectorAll(sel)[0] || null;

  const sandbox = { document, console };
  vm.runInNewContext(src, sandbox, { filename: "client-search.js" });

  const input = created.find((n) => n.id === "board-search");
  assert.ok(input, "search input injected");

  // Type Claddagh — only Claddagh card visible; Mahaffey's hidden; quiet empty.
  input.value = "Claddagh";
  input.dispatch("input");
  assert.equal(claddagh.hidden, false);
  assert.equal(mahaffeys.hidden, true);
  assert.equal(group.hidden, false);
  assert.equal(barracudas.hidden, true);
  assert.equal(quiet.hidden, true);

  // Barracudas in quiet group
  input.value = "barracudas";
  input.dispatch("input");
  assert.equal(claddagh.hidden, true);
  assert.equal(mahaffeys.hidden, true);
  assert.equal(group.hidden, true);
  assert.equal(barracudas.hidden, false);
  assert.equal(quiet.hidden, false);

  // Empty result message
  input.value = "xyzzy-no-match";
  input.dispatch("input");
  const empty = created.find((n) => (n.className || n._cn || "").includes("search-empty"));
  assert.ok(empty, "empty notice node");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /No places match 'xyzzy-no-match'/);

  // Clear restores
  input.value = "";
  input.dispatch("input");
  assert.equal(claddagh.hidden, false);
  assert.equal(mahaffeys.hidden, false);
  assert.equal(group.hidden, false);
  assert.equal(barracudas.hidden, false);
  assert.equal(quiet.hidden, false);
  assert.equal(empty.hidden, true);
});
