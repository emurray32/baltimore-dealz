// Browser-side copy of the day/deal selection logic from src/deals.js.
// Kept as a plain script (no imports) so the static Pages build needs zero
// tooling. Equivalence with the server module is pinned by test/static.test.js
// — if you change hasEnded / dayKeyInZone / dealsForDay / dealTiming /
// minutesNowInZone in deals.js, change the matching functions here the same way.

(function (global) {
  var BD = global.BD || {};

  BD.BALTIMORE_TZ = "America/New_York";

  BD.WEEK = [
    { key: "mon", label: "Monday" },
    { key: "tue", label: "Tuesday" },
    { key: "wed", label: "Wednesday" },
    { key: "thu", label: "Thursday" },
    { key: "fri", label: "Friday" },
    { key: "sat", label: "Saturday" },
    { key: "sun", label: "Sunday" },
  ];

  var WEEKDAY_FORMATTERS = new Map();

  function weekdayFormatter(timeZone) {
    var formatter = WEEKDAY_FORMATTERS.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("en-US", { timeZone: timeZone, weekday: "short" });
      WEEKDAY_FORMATTERS.set(timeZone, formatter);
    }
    return formatter;
  }

  // Which day is it *in Baltimore*, not on whatever machine is serving the page.
  BD.dayKeyInZone = function dayKeyInZone(date, timeZone) {
    if (timeZone === undefined) timeZone = BD.BALTIMORE_TZ;
    return weekdayFormatter(timeZone).format(date).toLowerCase();
  };

  BD.dayLabel = function dayLabel(dayKey) {
    var found = BD.WEEK.find(function (day) {
      return day.key === dayKey;
    });
    return found ? found.label : dayKey;
  };

  var VERIFIED = "verified";

  BD.isRenderable = function isRenderable(venue) {
    return venue.status === VERIFIED;
  };

  // Absent status renders; "held" does not.
  BD.isDealRenderable = function isDealRenderable(deal) {
    return deal.status === undefined;
  };

  // Flattens venues into one row per deal running on dayKey. Same filters as
  // src/deals.js: unverified venues and held rows never reach a card.
  BD.dealsForDay = function dealsForDay(venues, dayKey) {
    var rows = [];
    for (var i = 0; i < venues.length; i++) {
      var venue = venues[i];
      if (!BD.isRenderable(venue)) continue;
      for (var j = 0; j < venue.deals.length; j++) {
        var deal = venue.deals[j];
        if (!BD.isDealRenderable(deal)) continue;
        if (deal.days.indexOf(dayKey) !== -1) {
          rows.push({ venue: venue, deal: deal });
        }
      }
    }
    return rows;
  };

  // end: null means the venue published no end time — never "ended".
  BD.hasEnded = function hasEnded(deal, minutesNow) {
    if (deal.end === null || deal.end === undefined) return false;
    return minutesNow >= deal.end;
  };

  // Minutes past midnight in Baltimore (or another zone).
  BD.minutesNowInZone = function minutesNowInZone(date, timeZone) {
    if (timeZone === undefined) timeZone = BD.BALTIMORE_TZ;
    if (date === undefined) date = new Date();
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(date);
    var hour = 0;
    var minute = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") hour = Number(parts[i].value);
      if (parts[i].type === "minute") minute = Number(parts[i].value);
    }
    return hour * 60 + minute;
  };

  // on_now | starts_later | hours_unlisted | finished — same as src/deals.js.
  BD.dealTiming = function dealTiming(deal, minutesNow) {
    if (BD.hasEnded(deal, minutesNow)) return "finished";
    if (deal.start === null || deal.start === undefined) return "hours_unlisted";
    if (minutesNow < deal.start) return "starts_later";
    return "on_now";
  };

  global.BD = BD;
})(typeof globalThis !== "undefined" ? globalThis : window);
