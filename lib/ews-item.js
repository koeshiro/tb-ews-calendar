// ews-item.js — convert between the normalized EWS item shape and calIEvent.
// Thunderbird-only: creates Lightning XPCOM objects (calIEvent / calIAttendee)
// and stores EWS metadata on the event via calIPropertyBag so later
// Update/Delete round-trips can recover the server id + change key.
//
// The normalized item shape (produced by ews-client.parseCalendarItem):
//   { id, changeKey, subject, bodyHtml, bodyText, startISO, endISO, isAllDay,
//     location, organizer, organizerName, meetingRequestType, isOnlineMeeting,
//     attendees: [ { name, email, type, response } ] }

var EXPORTED_SYMBOLS = ["itemToCalEvent", "calEventToItem"];

var _dt = require("./ews-datetime.js");

// calUtils' cal (createDateTime) — injected into the module scope by the
// experiment loader; null under Node tests.
var _cal = typeof cal !== "undefined" ? cal : null;

// EWS attendee <t:ResponseType> -> ICAL PARTSTAT value (calIAttendee
// .participationStatus in Thunderbird is the raw ical string).
var RESPONSE_TO_PARTSTAT = {
  "Accept": "ACCEPTED",
  "Decline": "DECLINED",
  "Tentative": "TENTATIVE",
  "Organizer": "ACCEPTED",
  "NoResponseReceived": "NEEDS-ACTION",
  "None": "NEEDS-ACTION",
};
// EWS <t:AttendeeType> -> ICAL ROLE value (calIAttendee.role).
var TYPE_TO_ROLE = {
  "Required": "REQ-PARTICIPANT",
  "Optional": "OPT-PARTICIPANT",
  "Resource": "NON-PARTICIPANT",
};
var PARTSTAT_TO_RESPONSE = {
  "ACCEPTED": "Accept",
  "DECLINED": "Decline",
  "TENTATIVE": "Tentative",
  "NEEDS-ACTION": "NoResponseReceived",
  "PROCESSING": "NoResponseReceived",
};
var ROLE_TO_TYPE = {
  "REQ-PARTICIPANT": "Required",
  "OPT-PARTICIPANT": "Optional",
  "NON-PARTICIPANT": "Resource",
  "CHAIR": "Required",
};

function _makeEvent() {
  // CalEvent/CalAttendee constructors are injected by the experiment loader
  // (the "@mozilla.org/calendar/event;1" XPCOM contracts are gone).
  return new CalEvent();
}
function _makeAttendee() {
  return new CalAttendee();
}

// item (normalized EWS) -> calIEvent
function itemToCalEvent(item, cal) {
  var evt = _makeEvent();
  try {
    evt.id = "ews:" + (item.id || "");
  } catch (e) {}
  try {
    evt.title = item.subject || "(no subject)";
  } catch (e) {}
  try {
    evt.descriptionText = item.bodyText || "";
  } catch (e) {}
  try {
    if (item.location) {
      evt.setProperty("LOCATION", item.location);
    }
  } catch (e) {}

  // TB 160 CalEvent: dates are startDate/endDate (backed by DTSTART/DTEND).
  // There are no startTime/endTime/description/location/attendees accessors
  // on the class — assigning those would silently create dead expando
  // properties, and CalStorageCalendar writes event_start from
  // item.startDate, so a missed assignment yields dateless (invisible) rows.
  // cal.createDateTime(icalString) gives UTC for "20260922T090000Z" and
  // isDate=true for DATE values ("20260922") — the latter is how all-day
  // events are represented (there is no isDayEvent in current Thunderbird).
  try {
    var startVal = _dt.isoToIcal(item.startISO, item.isAllDay);
    var endVal = _dt.isoToIcal(item.endISO, item.isAllDay);
    if (!startVal || !endVal) {
      throw new Error("unparsable ISO: " + item.startISO + " / " + item.endISO);
    }
    if (!_cal || !_cal.createDateTime) {
      throw new Error("cal.createDateTime not available in scope");
    }
    evt.startDate = _cal.createDateTime(startVal);
    evt.endDate = _cal.createDateTime(endVal);
  } catch (e) {
    console.warn("ews: event dates not set: " + (e && e.message ? e.message : e));
  }

  var atts = [];
  if (item.attendees && item.attendees.length) {
    for (var i = 0; i < item.attendees.length; i++) {
      var a = item.attendees[i];
      var att = _makeAttendee();
      try {
        att.id = a.email ? "mailto:" + a.email : "";
      } catch (e) {}
      try {
        att.commonName = a.name || a.email || "";
      } catch (e) {}
      try {
        att.participationStatus = RESPONSE_TO_PARTSTAT[a.response] || "NEEDS-ACTION";
      } catch (e) {}
      try {
        att.role = TYPE_TO_ROLE[a.type] || "REQ-PARTICIPANT";
      } catch (e) {}
      atts.push(att);
    }
  }
  try {
    for (var ai = 0; ai < atts.length; ai++) {
      evt.addAttendee(atts[ai]);
    }
  } catch (e) {
    console.warn("ews: attendees not set: " + (e && e.message ? e.message : e));
  }

  // EWS metadata (calIPropertyBag) for round-tripping.
  try {
    evt.setProperty("ews-itemId", item.id || "");
    evt.setProperty("ews-changeKey", item.changeKey || "");
    evt.setProperty("ews-organizer", item.organizer || "");
    evt.setProperty("ews-meetingRequestType", item.meetingRequestType || "");
    evt.setProperty("ews-isOnlineMeeting", item.isOnlineMeeting ? "1" : "0");
  } catch (e) {}

  try {
    if (cal) {
      evt.calendar = cal;
    }
  } catch (e) {}
  return evt;
}

// calIEvent -> normalized EWS item (for Create/Update). `existing` carries the
// server-side fields that a local edit cannot know (id, changeKey, organizer).
function calEventToItem(evt, existing) {
  existing = existing || {};
  var item = {
    id: existing.id || (safeGetProp(evt, "ews-itemId") || null),
    changeKey: existing.changeKey || (safeGetProp(evt, "ews-changeKey") || null),
    subject: safeGet(evt, "title") || "",
    bodyText: safeGet(evt, "descriptionText") || "",
    bodyHtml: null,
    startISO: _dt.prTimeToISO(_nativeOf(safeGet(evt, "startDate"))),
    endISO: _dt.prTimeToISO(_nativeOf(safeGet(evt, "endDate"))),
    isAllDay: _isDateOf(safeGet(evt, "startDate")),
    location: safeGetProp(evt, "LOCATION") || "",
    organizer: existing.organizer || safeGetProp(evt, "ews-organizer") || null,
    organizerName: existing.organizerName || null,
    meetingRequestType:
      existing.meetingRequestType || safeGetProp(evt, "ews-meetingRequestType") || null,
    isOnlineMeeting: !!existing.isOnlineMeeting,
    attendees: [],
  };
  try {
    var atts = evt.getAttendees ? evt.getAttendees() : null;
    if (atts) {
      for (var i = 0; i < atts.length; i++) {
        var a = atts[i];
        var email = "";
        try {
          email = a.id || "";
          if (email.indexOf("mailto:") === 0) {
            email = email.substring(7);
          }
        } catch (e) {}
        var type = "Required";
        try {
          type = ROLE_TO_TYPE[a.role] || "Required";
        } catch (e) {}
        var response = "NoResponseReceived";
        try {
          response = PARTSTAT_TO_RESPONSE[a.participationStatus] || "NoResponseReceived";
        } catch (e) {}
        item.attendees.push({
          name: (a.commonName || email || ""),
          email: email,
          type: type,
          response: response,
        });
      }
    }
  } catch (e) {}
  return item;
}

function safeGet(obj, prop) {
  try {
    return obj[prop];
  } catch (e) {
    return null;
  }
}
// startDate/endDate is a calIDateTime; PRTime helpers need the numeric
// nativeTime (fall back to a raw number for non-TB callers).
function _nativeOf(dt) {
  try {
    if (dt && typeof dt === "object" && dt.nativeTime != null) {
      return dt.nativeTime;
    }
  } catch (e) {}
  return typeof dt === "number" ? dt : 0;
}
function _isDateOf(dt) {
  try {
    return !!(dt && dt.isDate);
  } catch (e) {
    return false;
  }
}
function safeGetProp(obj, prop) {
  try {
    return obj.getProperty(prop);
  } catch (e) {
    return null;
  }
}

// Node test export / experiment-loader export (the loader reads
// module.exports; the old EXPORTED_SYMBOLS path is no longer used).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    itemToCalEvent: itemToCalEvent,
    calEventToItem: calEventToItem,
  };
}
