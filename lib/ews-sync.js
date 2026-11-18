// ews-sync.js — one full sync run against EWS (FindItem + CalendarView).
// Some EWS gateways return empty Changes for SyncFolderItems, so the
// sync is a windowed FindItem: [now - SYNC_PAST_DAYS, now + SYNC_FUTURE_DAYS].
// If the server truncates at MaxEntriesReturned (IncludesLastItemInRange is
// false), the window is split in halves recursively and results are merged.
// Returns a resolved Promise (never rejects) shaped:
//   { ok, httpCode, items, windowStartISO, windowEndISO, error }
// The provider upserts fetched items and removes items that vanished from
// the window.

var EXPORTED_SYMBOLS = ["runSync", "SYNC_MAX_ITEMS", "SYNC_PAST_DAYS", "SYNC_FUTURE_DAYS"];

var _client = require("./ews-client.js");
var _transport = require("./ews-transport.js");

var SYNC_MAX_ITEMS = 1000;
var SYNC_PAST_DAYS = 180;
var SYNC_FUTURE_DAYS = 400;

var MAX_DEPTH = 6;

function iso(daysFromNow) {
  return new Date(Date.now() + daysFromNow * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fetchWindow(config, startISO, endISO, depth) {
  var body = _client.buildFindItemCalendarView(startISO, endISO, null, SYNC_MAX_ITEMS);
  return _transport.post(body, config).then(function (r) {
    if (r.httpCode === 401 && !r.error) {
      r.error = "auth rejected (HTTP 401)";
    }
    if (!r.doc) {
      return {
        ok: false,
        httpCode: r.httpCode,
        items: [],
        error: r.error || "empty response (HTTP " + r.httpCode + ")",
      };
    }
    var parsed = _client.parseFindItem(r.doc);
    if (!parsed.status.ok) {
      return {
        ok: false,
        httpCode: r.httpCode,
        items: [],
        error: (parsed.status.code || "error") + " " + (parsed.status.message || ""),
      };
    }
    if (!parsed.includesLast && depth < MAX_DEPTH && Date.parse(endISO) - Date.parse(startISO) > 7 * 86400000) {
      // Truncated: split the window in halves and merge (ids are unique).
      var mid = new Date((Date.parse(startISO) + Date.parse(endISO)) / 2).toISOString().replace(/\.\d{3}Z$/, "Z");
      return fetchWindow(config, startISO, mid, depth + 1).then(function (left) {
        if (!left.ok) {
          return left;
        }
        return fetchWindow(config, mid, endISO, depth + 1).then(function (right) {
          if (!right.ok) {
            return right;
          }
          var seen = {};
          var merged = [];
          left.items.concat(right.items).forEach(function (it) {
            if (it.id && !seen[it.id]) {
              seen[it.id] = true;
              merged.push(it);
            }
          });
          return { ok: true, httpCode: r.httpCode, items: merged };
        });
      });
    }
    return { ok: true, httpCode: r.httpCode, items: parsed.items };
  });
}

function runSync(config, callbacks) {
  callbacks = callbacks || {};
  var windowStartISO = iso(-SYNC_PAST_DAYS);
  var windowEndISO = iso(SYNC_FUTURE_DAYS);
  try {
    if (callbacks.onProgress) {
      callbacks.onProgress("FindItem window");
    }
  } catch (e) {}
  return fetchWindow(config, windowStartISO, windowEndISO, 0)
    .then(function (r) {
      if (!r.ok) {
        return {
          ok: false,
          httpCode: r.httpCode,
          items: [],
          windowStartISO: windowStartISO,
          windowEndISO: windowEndISO,
          error: r.error,
        };
      }
      return {
        ok: true,
        httpCode: r.httpCode,
        items: r.items,
        windowStartISO: windowStartISO,
        windowEndISO: windowEndISO,
        error: null,
      };
    })
    .catch(function (e) {
      return {
        ok: false,
        httpCode: 0,
        items: [],
        windowStartISO: windowStartISO,
        windowEndISO: windowEndISO,
        error: String(e),
      };
    });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runSync: runSync,
    SYNC_MAX_ITEMS: SYNC_MAX_ITEMS,
    SYNC_PAST_DAYS: SYNC_PAST_DAYS,
    SYNC_FUTURE_DAYS: SYNC_FUTURE_DAYS,
  };
}
