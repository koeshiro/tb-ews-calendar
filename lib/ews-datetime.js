// ews-datetime.js — ISO8601 (UTC) <-> PRTime and EWS TimeZone helpers.
// Pure (no Thunderbird dependencies) so it can be exercised in Node.

// Thunderbird (ChromeUtils.import) module exports; the Node `module.exports`
// guard at the bottom covers `require()` in tests.
var EXPORTED_SYMBOLS = [
  "PRTIME_EPOCH_OFFSET_MS", "msToPRTime", "prTimeToMs", "isoToPRTime",
  "isoToIcal", "prTimeToISO", "tzInfo", "timeZoneXml"
];

// Microseconds between the PRTime epoch (1601-01-01) and the Unix epoch (1970-01-01).
var PRTIME_EPOCH_OFFSET_MS = 11644473600000;

// ms since 1970 -> PRTime (µs since 1601).
function msToPRTime(ms) {
  return (ms + PRTIME_EPOCH_OFFSET_MS) * 1000;
}

// PRTime (µs since 1601) -> ms since 1970.
function prTimeToMs(pt) {
  return pt / 1000 - PRTIME_EPOCH_OFFSET_MS;
}

// EWS ISO8601 UTC string ("2026-07-01T10:00:00.000Z") -> PRTime.
function isoToPRTime(iso) {
  if (!iso) {
    return 0;
  }
  var ms = Date.parse(iso);
  if (isNaN(ms)) {
    return 0;
  }
  return msToPRTime(ms);
}

// ISO8601 ("2026-09-22T09:00:00Z") -> compact iCalendar value
// ("20260922T090000Z") as accepted by CalDateTime.icalString; "Z" is kept
// when the input is UTC/offset-tagged, a naive input stays floating. With
// keepDate=true (or a time-less input) returns a DATE value ("20260922"),
// which makes CalDateTime.isDate = true for all-day events.
function isoToIcal(iso, keepDate) {
  if (!iso) {
    return null;
  }
  var s = String(iso);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/);
  if (!m) {
    return null;
  }
  var v = m[1] + m[2] + m[3];
  if (keepDate || !m[4]) {
    return v;
  }
  var utc = /(?:Z|[+-]\d{2}:?\d{2})\s*$/.test(s);
  return v + "T" + m[4] + m[5] + (m[6] || "00") + (utc ? "Z" : "");
}

// PRTime -> EWS ISO8601 UTC string with millisecond precision.
function prTimeToISO(pt) {
  var ms = prTimeToMs(pt);
  if (isNaN(ms)) {
    return "";
  }
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// Local timezone info for EWS <t:TimeZone>.
// EWS convention: Bias = UTC − local time, in minutes (Moscow UTC+3 -> -180).
// Returns { bias, name, label, offsetMin }.
function tzInfo() {
  var name = "";
  try {
    name = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch (e) {
    name = "";
  }
  var now = new Date();
  // Build a UTC timestamp from the local wall-clock fields; the difference
  // against the real instant is the local offset.
  var asUTC = Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  );
  var offsetMin = Math.round((asUTC - now.getTime()) / 60000);
  var bias = -offsetMin;
  var sign = offsetMin >= 0 ? "+" : "-";
  var abs = Math.abs(offsetMin);
  var label = "UTC" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60);
  return { bias: bias, name: name, label: label, offsetMin: offsetMin };
}

// Build the <t:TimeZone> element for a CalendarView/FindItem request.
function timeZoneXml(tz) {
  var info = tz || tzInfo();
  return (
    "<t:TimeZone><t:Bias>" + info.bias +
    "</t:Bias><t:Name>" + escapeLocal(info.name || "UTC") + "</t:Name></t:TimeZone>"
  );
}

function escapeLocal(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Node test export (ignored in Thunderbird where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PRTIME_EPOCH_OFFSET_MS: PRTIME_EPOCH_OFFSET_MS,
    msToPRTime: msToPRTime,
    prTimeToMs: prTimeToMs,
    isoToPRTime: isoToPRTime,
    isoToIcal: isoToIcal,
    prTimeToISO: prTimeToISO,
    tzInfo: tzInfo,
    timeZoneXml: timeZoneXml,
  };
}
