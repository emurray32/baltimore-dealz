// Food filter for the board. Reads buttons in #food-filter and shows/hides
// .card elements by data-food. Multi-category rows (Claddagh Sat) match every
// category they carry. Counts on the buttons are whole-week and baked
// server-side; this script reports what is visible after filtering.
//
// Empty result says so in words — never a silent blank board.

(function () {
  var bar = document.getElementById("food-filter");
  if (!bar) return;
  var status = document.getElementById("filter-status");
  var buttons = Array.prototype.slice.call(bar.querySelectorAll(".filter-btn"));
  // All food-tagged cards: tonight (including timing groups) + week accordion.
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card[data-food]"));

  function apply(cat) {
    var showing = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var food = card.getAttribute("data-food") || "";
      var match =
        cat === "" || (" " + food + " ").indexOf(" " + cat + " ") !== -1;
      // Use a class so search (hidden) and filter can compose.
      if (match) {
        card.classList.remove("filter-hide");
        showing++;
      } else {
        card.classList.add("filter-hide");
      }
    }
    // Hide empty timing groups when every card inside is filter-hidden.
    var groups = document.querySelectorAll(".timing-group");
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var groupCards = group.querySelectorAll("article.card");
      var any = false;
      for (var c = 0; c < groupCards.length; c++) {
        if (!groupCards[c].classList.contains("filter-hide")) {
          any = true;
          break;
        }
      }
      if (cat === "") {
        group.classList.remove("filter-hide");
      } else {
        if (any) group.classList.remove("filter-hide");
        else group.classList.add("filter-hide");
      }
    }
    if (status) {
      if (cat === "") {
        status.textContent = "";
      } else if (showing === 0) {
        status.textContent = "No deals match that filter.";
      } else if (showing === 1) {
        status.textContent = "1 deal matches that filter on this board.";
      } else {
        status.textContent = showing + " deals match that filter on this board.";
      }
    }
  }

  for (var b = 0; b < buttons.length; b++) {
    buttons[b].addEventListener("click", function () {
      for (var k = 0; k < buttons.length; k++) {
        buttons[k].classList.remove("is-on");
        buttons[k].setAttribute("aria-pressed", "false");
      }
      this.classList.add("is-on");
      this.setAttribute("aria-pressed", "true");
      apply(this.getAttribute("data-filter") || "");
    });
  }
})();
