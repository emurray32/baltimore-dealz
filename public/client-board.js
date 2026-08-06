// Hydrates a pre-rendered board so "tonight" follows America/New_York in the
// browser. Build-time HTML is a skeleton (plus one template per weekday); this
// script picks today's template, updates the day label, and marks the week
// accordion. Requires client-day.js (window.BD) and #bd-venues JSON.

(function () {
  if (typeof BD === "undefined") return;

  var venuesEl = document.getElementById("bd-venues");
  var board = document.getElementById("tonight-board");
  if (!venuesEl || !board) return;

  var venues;
  try {
    venues = JSON.parse(venuesEl.textContent);
  } catch (err) {
    return;
  }

  var now = new Date();
  var todayKey = BD.dayKeyInZone(now);
  var todayLabel = BD.dayLabel(todayKey);

  // Header line under the title: "Friday · Baltimore time"
  var headerMetas = document.querySelectorAll("header > p.meta");
  if (headerMetas.length > 0) {
    headerMetas[0].textContent = todayLabel + " · Baltimore time";
  }

  // Swap the "On tonight" cards for today's pre-rendered template. Templates
  // were built with the same dealCard markup as the server, so the look matches.
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

  // Week accordion: one "(tonight)" marker on today's day, none elsewhere.
  var details = document.querySelectorAll("details[data-day]");
  for (var d = 0; d < details.length; d++) {
    var el = details[d];
    var summary = el.querySelector("summary");
    if (!summary) continue;
    var key = el.getAttribute("data-day");
    var base = BD.dayLabel(key);
    summary.textContent = key === todayKey ? base + " (tonight)" : base;
  }

  // Exposed for the static suite (and nothing else). Lets a test drive the same
  // selection the page just made without re-deriving day semantics.
  board.setAttribute("data-tonight-key", todayKey);
  // Also stash the row count the client logic believes is on tonight — the
  // suite compares this to server dealsForDay for the same instant.
  var rows = BD.dealsForDay(venues, todayKey);
  board.setAttribute("data-tonight-count", String(rows.length));
})();
