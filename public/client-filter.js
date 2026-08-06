// Food filter for the board. Reads the buttons renderServer put in
// #food-filter and shows/hides .card elements by their data-food attribute.
// Pure DOM, no framework — the same file is served by the live server and
// copied into the static build. Counts on the buttons are whole-week and
// baked in server-side; this script only reports what is visible *today*.

(function () {
  var bar = document.getElementById("food-filter");
  if (!bar) return;
  var status = document.getElementById("filter-status");
  var buttons = Array.prototype.slice.call(bar.querySelectorAll(".filter-btn"));
  // All cards on the page: "On tonight" list plus every day in the week
  // accordion. Filtering is board-wide, so a category match on another day
  // still shows when the customer opens that day.
  var cards = Array.prototype.slice.call(document.querySelectorAll(".card[data-food]"));

  function apply(cat) {
    var showing = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var match = cat === "" || (" " + card.getAttribute("data-food") + " ").indexOf(" " + cat + " ") !== -1;
      card.style.display = match ? "" : "none";
      if (match) showing++;
    }
    if (status) {
      if (cat === "") {
        status.textContent = "";
      } else if (showing === 1) {
        status.textContent = "1 deal on the board this week.";
      } else {
        status.textContent = showing + " deals on the board this week.";
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
