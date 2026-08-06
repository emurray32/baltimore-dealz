// Client-side board search. Filters venues already on the page as you type.
// Plain case-insensitive substring on card/quiet text. Does NOT reorder timing
// groups — filters within On now / Starts later / Finished so a match still
// tells you whether that place is pouring right now.
//
// Injects its own UI so a JS-less page never shows a dead search box.
// Requires nothing from BD; runs after client-board.js has grouped cards.

(function () {
  var board = document.getElementById("tonight-board");
  if (!board) return;

  // Build the control only when JS is running.
  var row = document.createElement("p");
  row.className = "search-row";
  row.innerHTML =
    '<label class="search-label" for="board-search">Search this board</label>' +
    '<input type="search" id="board-search" class="board-search" ' +
    'placeholder="Bar name…" autocomplete="off" enterkeyhint="search">';

  // Insert after the nearest-row (or after h2 if that is missing).
  var nearest = board.querySelector(".nearest-row");
  if (nearest && nearest.nextSibling) {
    board.insertBefore(row, nearest.nextSibling);
  } else if (nearest) {
    board.appendChild(row);
  } else {
    var h2 = board.querySelector("h2");
    if (h2 && h2.nextSibling) board.insertBefore(row, h2.nextSibling);
    else board.insertBefore(row, board.firstChild);
  }

  var input = document.getElementById("board-search");
  if (!input) return;

  var empty = document.createElement("p");
  empty.className = "meta search-empty";
  empty.hidden = true;
  // Sit just under the search row so it is obvious.
  if (row.nextSibling) board.insertBefore(empty, row.nextSibling);
  else board.appendChild(empty);

  function cardText(card) {
    return (card.textContent || "").toLowerCase();
  }

  function quietText(li) {
    return (li.textContent || "").toLowerCase();
  }

  function apply(q) {
    var query = (q || "").trim().toLowerCase();
    var anyVisible = false;

    // Timing groups: filter cards inside each group; hide empty groups.
    var groups = board.querySelectorAll(".timing-group");
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var cards = group.querySelectorAll("article.card");
      var groupHit = false;
      for (var c = 0; c < cards.length; c++) {
        var card = cards[c];
        var show = !query || cardText(card).indexOf(query) !== -1;
        card.hidden = !show;
        if (show) {
          groupHit = true;
          anyVisible = true;
        }
      }
      // Empty query: always show groups that have cards (all cards unhidden).
      group.hidden = query ? !groupHit : false;
    }

    // Ungrouped cards (noscript / before regroup edge case).
    var loose = board.querySelectorAll(":scope > article.card");
    for (var i = 0; i < loose.length; i++) {
      var showLoose = !query || cardText(loose[i]).indexOf(query) !== -1;
      loose[i].hidden = !showLoose;
      if (showLoose) anyVisible = true;
    }

    // Quiet group — searchable so Barracudas is findable with an honest reason.
    var quiet = document.querySelector("section.quiet");
    if (quiet) {
      var items = quiet.querySelectorAll(".quiet-list > li");
      var quietHit = false;
      for (var qli = 0; qli < items.length; qli++) {
        var li = items[qli];
        var showQ = !query || quietText(li).indexOf(query) !== -1;
        li.hidden = !showQ;
        if (showQ) {
          quietHit = true;
          anyVisible = true;
        }
      }
      quiet.hidden = query ? !quietHit : false;
      // Open the details when a quiet match is the only place they appear.
      var details = quiet.querySelector("details");
      if (details && query && quietHit) details.open = true;
    }

    // Week accordion cards (same page — filter in place, do not collapse day labels).
    var weekCards = document.querySelectorAll("main > section details article.card");
    for (var w = 0; w < weekCards.length; w++) {
      var wc = weekCards[w];
      var showW = !query || cardText(wc).indexOf(query) !== -1;
      wc.hidden = !showW;
      if (showW) anyVisible = true;
    }

    if (!query) {
      empty.hidden = true;
      empty.textContent = "";
      return;
    }

    if (!anyVisible) {
      empty.hidden = false;
      empty.textContent = "No places match '" + q.trim() + "'";
    } else {
      empty.hidden = true;
      empty.textContent = "";
    }
  }

  input.addEventListener("input", function () {
    apply(input.value);
  });
  // Clearing via the search field's native clear control also fires input.
  input.addEventListener("search", function () {
    apply(input.value);
  });
})();
