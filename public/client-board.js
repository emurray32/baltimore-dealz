// Hydrates a pre-rendered board so "tonight" follows America/New_York in the
// browser, then groups deal cards by time of day:
//   On now · Starts later · Finished
// Build-time HTML is a skeleton (plus one template per weekday on static builds);
// this script picks today's template, updates the day label, and regroups cards
// from the real clock. Requires client-day.js (window.BD). Does NOT read venue
// JSON — templates already carry only public card markup (no ops_notes, no held).

(function () {
  if (typeof BD === "undefined") return;

  var board = document.getElementById("tonight-board");
  if (!board) return;

  var now = new Date();
  var todayKey = BD.dayKeyInZone(now);
  var todayLabel = BD.dayLabel(todayKey);
  var minutesNow = BD.minutesNowInZone(now);

  // Header line under the title: day name only (city is in the page title).
  var headerMetas = document.querySelectorAll("header > p.meta");
  if (headerMetas.length > 0) {
    headerMetas[0].textContent = todayLabel;
  }

  // Swap the "On tonight" cards for today's pre-rendered template (static build).
  // Live server already rendered today's cards; there is no template then.
  var tpl = document.getElementById("bd-day-" + todayKey);
  if (tpl) {
    var keep = [];
    var children = board.children;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.tagName === "H2" || child.classList.contains("nearest-row")) {
        keep.push(child);
      }
    }
    board.innerHTML = "";
    for (var k = 0; k < keep.length; k++) board.appendChild(keep[k]);
    board.appendChild(tpl.content.cloneNode(true));
  }

  // Group article.card nodes by dealTiming (data-start / data-end on each card).
  var TIMING_ORDER = [
    { key: "on_now", label: "On now" },
    { key: "starts_later", label: "Starts later" },
    { key: "hours_unlisted", label: "Tonight — hours unlisted" },
    { key: "finished", label: "Finished" },
  ];

  function parseMinute(attr) {
    if (attr === null || attr === undefined || attr === "") return null;
    var n = Number(attr);
    return Number.isInteger(n) ? n : null;
  }

  function cardTiming(card) {
    var deal = {
      start: parseMinute(card.getAttribute("data-start")),
      end: parseMinute(card.getAttribute("data-end")),
    };
    return BD.dealTiming(deal, minutesNow);
  }

  var cards = Array.prototype.slice.call(board.querySelectorAll("article.card"));
  if (cards.length > 0) {
    var buckets = { on_now: [], starts_later: [], finished: [] };
    for (var c = 0; c < cards.length; c++) {
      var t = cardTiming(cards[c]);
      if (!buckets[t]) t = "on_now";
      buckets[t].push(cards[c]);
    }

    // Remove existing cards / prior timing groups; keep h2 + nearest-row.
    var preserved = [];
    var kids = Array.prototype.slice.call(board.children);
    for (var p = 0; p < kids.length; p++) {
      var el = kids[p];
      if (el.tagName === "H2" || el.classList.contains("nearest-row")) {
        preserved.push(el);
      }
    }
    board.innerHTML = "";
    for (var q = 0; q < preserved.length; q++) board.appendChild(preserved[q]);

    for (var g = 0; g < TIMING_ORDER.length; g++) {
      var group = TIMING_ORDER[g];
      var list = buckets[group.key];
      if (!list || list.length === 0) continue;
      var section = document.createElement("div");
      section.className = "timing-group";
      section.setAttribute("data-timing", group.key);
      var heading = document.createElement("h3");
      heading.className = "timing-heading";
      heading.textContent = group.label;
      section.appendChild(heading);
      var host = document.createElement("div");
      host.className = "timing-cards";
      for (var r = 0; r < list.length; r++) host.appendChild(list[r]);
      section.appendChild(host);
      board.appendChild(section);
    }
  }

  // Week accordion: one "(tonight)" marker on today's day, none elsewhere.
  var details = document.querySelectorAll("details[data-day]");
  for (var d = 0; d < details.length; d++) {
    var det = details[d];
    var summary = det.querySelector("summary");
    if (!summary) continue;
    var key = det.getAttribute("data-day");
    var base = BD.dayLabel(key);
    summary.textContent = key === todayKey ? base + " (tonight)" : base;
  }

  // Lets a static check (or a human inspecting the DOM) see which day the
  // client selected without re-deriving day semantics.
  board.setAttribute("data-tonight-key", todayKey);
  board.setAttribute("data-minutes-now", String(minutesNow));
})();
