// ews-client.js — EWS SOAP request builders + response parsers.
// Pure (no Thunderbird dependencies) so Node tests can drive it end-to-end.
// Import the pure helpers from ews-xml.js / ews-datetime.js.
//
// Wire format targets Exchange Web Services (RequestServerVersion
// Exchange2016, see ews-xml.js). Calendar folder = the "calendar"
// distinguished folder; item times are UTC ISO8601 strings.

var EXPORTED_SYMBOLS = [
  "NS", "cleanSmtp", "calendarFolderIdXml", "itemShapeXml", "tzXml",
  "buildFindFolder", "parseFindFolder", "buildFindItemCalendarView",
  "parseCalendarItem", "parseFindItem", "buildSyncFolderItems", "parseSync",
  "buildGetItem", "parseGetItem", "calendarItemXml", "buildCreateItem",
  "parseCreateItem", "buildUpdateItem", "buildDeleteItem",
  "buildResolveNames", "parseResolveNames", "buildRespondMeeting", "stripHtml"
];

var _xml = require("./ews-xml.js");
var _dt = require("./ews-datetime.js");

var NS = _xml.NS;

// --- shared helpers ---------------------------------------------------------

// 'smtp:user@mail.example.com' / 'sip:user@example.com' -> 'user@...'.
function cleanSmtp(value) {
  if (!value) {
    return "";
  }
  value = String(value).trim();
  var lower = value.toLowerCase();
  if (lower.indexOf("smtp:") === 0 || lower.indexOf("sip:") === 0 || lower.indexOf("x500:") === 0) {
    return value.substring(value.indexOf(":") + 1);
  }
  return value;
}

// A <t:DistinguishedFolderId> for the user's default calendar folder.
function calendarFolderIdXml() {
  return "<t:DistinguishedFolderId Id=\"calendar\"/>";
}

// ItemShape. BaseShape "All" is rejected by some EWS gateways
// (ErrorInvalidRequest); "Default" returns Subject/Start/End/Location/
// Organizer without attendees/body — good enough for calendar display.
function itemShapeXml() {
  return "<m:ItemShape><t:BaseShape>Default</t:BaseShape></m:ItemShape>";
}

// <t:TimeZone> for a view/sync request.
function tzXml(tz) {
  return _dt.timeZoneXml(tz);
}

// --- FindFolder (calendar folder metadata) -----------------------------------

function buildFindFolder() {
  var body =
    "<m:FindFolder xmlns:m=\"" + NS.m + "\" Traversal=\"Shallow\">" +
    "<m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape>" +
    "<m:ParentFolderIds>" + calendarFolderIdXml() + "</m:ParentFolderIds>" +
    "</m:FindFolder>";
  return _xml.soapEnvelope(body);
}

function parseFindFolder(doc) {
  var status = _xml.responseStatus(doc);
  var folder = _xml.findDesc(doc, "t:CalendarFolder") || _xml.findDesc(doc, "t:Folder");
  var result = { status: status, folderId: null, displayName: null, serverId: null, totalCount: 0 };
  if (folder) {
    var idEl = _xml.child(folder, "t:FolderId");
    result.serverId = _xml.attr(idEl, "Id") || null;
    result.displayName = _xml.childText(folder, "t:DisplayName");
    result.totalCount = parseInt(_xml.childText(folder, "t:TotalCount") || "0", 10) || 0;
  }
  return result;
}

// --- FindItem (CalendarView) -------------------------------------------------

function buildFindItemCalendarView(startISO, endISO, tz, maxItems) {
  var body =
    "<m:FindItem xmlns:m=\"" + NS.m + "\" Traversal=\"Shallow\">" +
    itemShapeXml() +
    "<m:CalendarView StartDate=\"" + _xml.escapeXml(startISO) +
    "\" EndDate=\"" + _xml.escapeXml(endISO) + "\"" +
    (maxItems ? " MaxEntriesReturned=\"" + maxItems + "\"" : "") + "/>" +
    "<m:ParentFolderIds>" + calendarFolderIdXml() + "</m:ParentFolderIds>" +
    "</m:FindItem>";
  return _xml.soapEnvelope(body);
}

// Normalize a <t:CalendarItem> element into a plain object.
function parseCalendarItem(el) {
  var item = {
    id: null,
    changeKey: null,
    subject: null,
    bodyHtml: null,
    bodyText: null,
    startISO: null,
    endISO: null,
    isAllDay: false,
    location: null,
    organizer: null,
    organizerName: null,
    meetingRequestType: null,
    isOnlineMeeting: false,
    attendees: [],
  };
  if (!el) {
    return item;
  }
  var idEl = _xml.child(el, "t:ItemId");
  item.id = _xml.attr(idEl, "Id") || null;
  item.changeKey = _xml.attr(idEl, "ChangeKey") || null;
  item.subject = _xml.childText(el, "t:Subject");
  var bodyEl = _xml.child(el, "t:Body");
  if (bodyEl) {
    var bodyType = (_xml.attr(bodyEl, "BodyType") || "Text").toUpperCase();
    var bodyText = _xml.text(bodyEl);
    if (bodyType === "HTML") {
      item.bodyHtml = bodyText;
      item.bodyText = stripHtml(bodyText);
    } else {
      item.bodyText = bodyText;
      item.bodyHtml = "<pre>" + _xml.escapeXml(bodyText) + "</pre>";
    }
  }
  item.startISO = _xml.childText(el, "t:Start");
  item.endISO = _xml.childText(el, "t:End");
  item.isAllDay = (_xml.childText(el, "t:IsAllDayEvent") || "").toLowerCase() === "true";
  item.location = _xml.childText(el, "t:Location");
  var org = _xml.child(el, "t:Organizer");
  if (org) {
    item.organizer = cleanSmtp(_xml.childText(org, "t:Address"));
    item.organizerName = _xml.childText(org, "t:DisplayName");
  }
  item.meetingRequestType = _xml.childText(el, "t:MeetingRequestType");
  item.isOnlineMeeting = (_xml.childText(el, "t:IsOnlineMeeting") || "").toLowerCase() === "true";

  var attendees = _xml.child(el, "t:Attendees");
  if (attendees && attendees.childNodes) {
    var nodes = attendees.childNodes;
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      if (!a.nodeName || a.nodeName !== "t:Attendee") {
        continue;
      }
      var mailbox = _xml.child(a, "t:Mailbox");
      item.attendees.push({
        name: mailbox ? _xml.childText(mailbox, "t:Name") : null,
        email: mailbox ? cleanSmtp(_xml.childText(mailbox, "t:EmailAddress")) : null,
        type: _xml.childText(a, "t:AttendeeType"),
        response: _xml.childText(a, "t:ResponseType"),
      });
    }
  }
  return item;
}

// Parse a FindItem response. This gateway wraps items in m:RootFolder/t:Items
// (older schema used m:RootItems) — support both. Also returns the folder
// window stats: { status, items, totalInView, includesLast }.
function parseFindItem(doc) {
  var status = _xml.responseStatus(doc);
  var root = _xml.findDesc(doc, "m:RootFolder") || _xml.findDesc(doc, "m:RootItems");
  var items = [];
  if (root && root.childNodes) {
    var itemsEl = null;
    for (var i = 0; i < root.childNodes.length; i++) {
      if (root.childNodes[i].nodeName === "t:Items") {
        itemsEl = root.childNodes[i];
        break;
      }
    }
    var container = itemsEl || root;
    var nodes = container.childNodes || [];
    for (var j = 0; j < nodes.length; j++) {
      if (nodes[j].nodeName === "t:CalendarItem") {
        items.push(parseCalendarItem(nodes[j]));
      }
    }
  }
  var total = _xml.attr(root, "TotalItemsInView");
  var includesLast = (_xml.childText(root, "m:IncludesLastItemInRange") || "").toLowerCase() === "true";
  return {
    status: status,
    items: items,
    totalInView: total ? parseInt(total, 10) : null,
    includesLast: root ? includesLast : true,
  };
}

// --- SyncFolderItems (delta sync on the calendar folder) ----------------------

// One SyncFolderItems round. `syncState` is the opaque state returned by the
// previous round (null for the first). `windowISO` restricts the sync to the
// calendar window [start, end] so the calendar folder stays bounded; pass
// nulls to sync the whole folder.
function buildSyncFolderItems(syncState, tz, maxEntries, windowStartISO, windowEndISO) {
  var body =
    "<m:SyncFolderItems xmlns:m=\"" + NS.m + "\" Traversal=\"Shallow\">" +
    itemShapeXml() +
    "<m:SyncFolderId>" + calendarFolderIdXml() + "</m:SyncFolderId>" +
    (syncState ? "<m:SyncState>" + _xml.escapeXml(syncState) + "</m:SyncState>" : "") +
    (maxEntries ? "<m:MaxEntriesReturned>" + maxEntries + "</m:MaxEntriesReturned>" : "") +
    (windowStartISO && windowEndISO
      ? "<m:CalendarView StartDate=\"" + _xml.escapeXml(windowStartISO) +
        "\" EndDate=\"" + _xml.escapeXml(windowEndISO) + "\"/>"
      : "") +
    "</m:SyncFolderItems>";
  return _xml.soapEnvelope(body);
}

// Parse a SyncFolderItemsResponse. Returns
//   { status, syncState, includesLast, created:[item], updated:[item], deleted:[itemId] }
// created/updated contain normalized calendar items, deleted the EWS item ids.
function parseSync(doc) {
  var status = _xml.responseStatus(doc);
  var result = {
    status: status,
    syncState: _xml.childText(doc, "m:SyncState") || null,
    includesLast: (_xml.childText(doc, "m:IncludesLastItemInRange") || "").toLowerCase() === "true",
    created: [],
    updated: [],
    deleted: [],
  };
  var changes = _xml.findDesc(doc, "m:Changes");
  if (!changes || !changes.childNodes) {
    return result;
  }
  for (var i = 0; i < changes.childNodes.length; i++) {
    var change = changes.childNodes[i];
    var name = change.nodeName;
    if (name === "t:Create" || name === "t:Update") {
      var calItem = _xml.findDesc(change, "t:CalendarItem");
      if (calItem) {
        result[name === "t:Create" ? "created" : "updated"].push(parseCalendarItem(calItem));
      }
    } else if (name === "t:Delete") {
      var idEl = _xml.child(change, "t:ItemId");
      var id = _xml.attr(idEl, "Id");
      if (id) {
        result.deleted.push(id);
      }
    }
  }
  return result;
}

// --- GetItem ----------------------------------------------------------------

function buildGetItem(itemIds) {
  var ids = "";
  for (var i = 0; itemIds && i < itemIds.length; i++) {
    ids += "<t:ItemId Id=\"" + _xml.escapeXml(itemIds[i].id) +
      "\" ChangeKey=\"" + _xml.escapeXml(itemIds[i].changeKey || "") + "\"/>";
  }
  var body =
    "<m:GetItem xmlns:m=\"" + NS.m + "\">" + itemShapeXml() + "<m:ItemIds>" + ids + "</m:ItemIds>" +
    "</m:GetItem>";
  return _xml.soapEnvelope(body);
}

function parseGetItem(doc) {
  var status = _xml.responseStatus(doc);
  var items = [];
  var messages = _xml.findDescAll(doc, "m:GetItemResponseMessage");
  for (var i = 0; i < messages.length; i++) {
    var item = _xml.findDesc(messages[i], "t:CalendarItem");
    if (item) {
      items.push(parseCalendarItem(item));
    }
  }
  return { status: status, items: items };
}

// --- CreateItem -------------------------------------------------------------

// Build a <t:CalendarItem> for a create from a normalized item.
function calendarItemXml(item, tz) {
  var s = "<t:CalendarItem>";
  s += "<t:Subject>" + _xml.escapeXml(item.subject || "") + "</t:Subject>";
  if (item.bodyText) {
    s += "<t:Body BodyType=\"Text\">" + _xml.escapeXml(item.bodyText) + "</t:Body>";
  }
  s += "<t:Start>" + _xml.escapeXml(item.startISO || "") + "</t:Start>";
  s += "<t:End>" + _xml.escapeXml(item.endISO || "") + "</t:End>";
  s += "<t:IsAllDayEvent>" + (item.isAllDay ? "true" : "false") + "</t:IsAllDayEvent>";
  if (item.location) {
    s += "<t:Location>" + _xml.escapeXml(item.location) + "</t:Location>";
  }
  s += "<t:LegacyFreeBusyStatus>" + (item.isAllDay ? "Free" : "Busy") + "</t:LegacyFreeBusyStatus>";
  var atts = splitAttendees(item.attendees);
  if (atts.required) {
    s += "<t:RequiredAttendees>" + atts.required + "</t:RequiredAttendees>";
  }
  if (atts.optional) {
    s += "<t:OptionalAttendees>" + atts.optional + "</t:OptionalAttendees>";
  }
  s += "</t:CalendarItem>";
  return s;
}

// Split normalized attendees into EWS <t:Attendee> fragments { required, optional }.
function splitAttendees(attendees) {
  var req = "";
  var opt = "";
  (attendees || []).forEach(function (a) {
    if (!a.email) {
      return;
    }
    var isOpt = (a.type || "").toLowerCase() === "optional";
    var entry =
      "<t:Attendee><t:Mailbox><t:EmailAddress>" + _xml.escapeXml(a.email) + "</t:EmailAddress>" +
      (a.name ? "<t:Name>" + _xml.escapeXml(a.name) + "</t:Name>" : "") +
      "</t:Mailbox><t:AttendeeType>" +
      (isOpt ? "Optional" : "Required") + "</t:AttendeeType></t:Attendee>";
    if (isOpt) {
      opt += entry;
    } else {
      req += entry;
    }
  });
  return { required: req, optional: opt };
}

function buildCreateItem(item, opts) {
  opts = opts || {};
  var isMeeting = opts.isMeeting !== undefined
    ? opts.isMeeting
    : !!(item.attendees && item.attendees.length > 0);
  // This gateway rejects calendar CreateItem without SendMeetingInvitations
  // (ErrorSendMeetingInvitationsRequired) even for plain appointments.
  var attrs = " SendMeetingInvitations=\"" +
    (isMeeting && opts.sendInvites ? "SendToAllAndSaveCopy" : "SendToNone") + "\"";
  var body =
    "<m:CreateItem xmlns:m=\"" + NS.m + "\"" + attrs + ">" +
    "<m:SavedItemFolderId>" + calendarFolderIdXml() + "</m:SavedItemFolderId>" +
    "<m:Items>" + calendarItemXml(item, opts.tz) + "</m:Items>" +
    "</m:CreateItem>";
  return _xml.soapEnvelope(body);
}

function parseCreateItem(doc) {
  var status = _xml.responseStatus(doc);
  var item = _xml.findDesc(doc, "t:ItemId");
  return {
    status: status,
    id: item ? _xml.attr(item, "Id") : null,
    changeKey: item ? _xml.attr(item, "ChangeKey") : null,
  };
}

// --- UpdateItem -------------------------------------------------------------

// A change is { field: "Subject", valueXml: "<t:Subject>..</t:Subject>" }.
// The valueXml is the bare field element; it gets wrapped in <t:CalendarItem>
// inside <t:SetItemField>, as EWS requires for calendar items.
function buildUpdateItem(itemId, changeKey, changes, opts) {
  opts = opts || {};
  // Same gateway rule as CreateItem: the attribute must always be present.
  var attrs = " ConflictResolution=\"AlwaysOverwrite\"" +
    " SendMeetingInvitations=\"" +
    (opts.isMeeting && opts.sendInvites ? "SendToAllAndSaveCopy" : "SendToNone") + "\"";
  var updatesXml = "";
  for (var i = 0; i < changes.length; i++) {
    var c = changes[i];
    updatesXml +=
      "<t:SetItemField><t:FieldURI FieldURI=\"calendar:" + c.field + "\"/>" +
      "<t:CalendarItem>" + (c.valueXml || "") + "</t:CalendarItem>" +
      "</t:SetItemField>";
  }
  var body =
    "<m:UpdateItem xmlns:m=\"" + NS.m + "\"" + attrs + ">" +
    "<m:ItemChanges><t:ItemChange>" +
    "<t:ItemId Id=\"" + _xml.escapeXml(itemId) + "\" ChangeKey=\"" + _xml.escapeXml(changeKey || "") + "\"/>" +
    "<t:Updates>" + updatesXml + "</t:Updates>" +
    "</t:ItemChange></m:ItemChanges>" +
    "</m:UpdateItem>";
  return _xml.soapEnvelope(body);
}

// --- DeleteItem -------------------------------------------------------------

function buildDeleteItem(itemId, changeKey, opts) {
  opts = opts || {};
  // Same gateway rule: SendMeetingCancellations must always be present.
  var attrs = " DeleteType=\"SoftDelete\"" +
    " SendMeetingCancellations=\"" +
    (opts.isMeeting && opts.sendInvites ? "SendToAllAndSaveCopy" : "SendToNone") + "\"";
  var body =
    "<m:DeleteItem xmlns:m=\"" + NS.m + "\"" + attrs + ">" +
    "<m:ItemIds>" +
    "<t:ItemId Id=\"" + _xml.escapeXml(itemId) + "\" ChangeKey=\"" + _xml.escapeXml(changeKey || "") + "\"/>" +
    "</m:ItemIds>" +
    "</m:DeleteItem>";
  return _xml.soapEnvelope(body);
}

// --- ResolveNames -----------------------------------------------------------

function buildResolveNames(entry) {
  var body =
    "<m:ResolveNames xmlns:m=\"" + NS.m + "\" ReturnFullContactData=\"true\">" +
    "<m:UnresolvedEntry>" + _xml.escapeXml(entry) + "</m:UnresolvedEntry>" +
    "</m:ResolveNames>";
  return _xml.soapEnvelope(body);
}

function parseResolveNames(doc) {
  var status = _xml.responseStatus(doc);
  var results = [];
  var res = _xml.findDescAll(doc, "t:Resolution");
  for (var i = 0; i < res.length; i++) {
    var mailbox = _xml.child(res[i], "t:Mailbox");
    var contact = _xml.child(res[i], "t:Contact");
    var email = mailbox ? cleanSmtp(_xml.childText(mailbox, "t:EmailAddress")) : null;
    var name = mailbox ? _xml.childText(mailbox, "t:Name") : null;
    var displayName = contact ? _xml.childText(contact, "t:DisplayName") : null;
    var entryIdEl = _xml.child(res[i], "t:ItemId");
    results.push({
      name: name,
      displayName: displayName,
      email: email,
      id: entryIdEl ? _xml.attr(entryIdEl, "Id") : null,
    });
  }
  return { status: status, results: results };
}

// --- Respond to a meeting ----------------------------------------------------

// Accept/TentativelyAccept/Decline a meeting as an attendee: EWS models this
// as a CreateItem of an AcceptItem / TentativelyAcceptItem / DeclineItem
// referring to the invitation via <t:ReferenceItemId>.
// `response` is one of "Accept" | "Tentative" | "Decline".
function buildRespondMeeting(itemId, changeKey, attendeeEmail, response) {
  var elementName = { Accept: "AcceptItem", Tentative: "TentativelyAcceptItem", Decline: "DeclineItem" }[response];
  if (!elementName) {
    elementName = "AcceptItem";
  }
  var body =
    "<m:CreateItem xmlns:m=\"" + NS.m + "\" SendMeetingInvitations=\"SendToAllAndSaveCopy\">" +
    "<m:Items><t:" + elementName + ">" +
    "<t:ReferenceItemId Id=\"" + _xml.escapeXml(itemId) + "\" ChangeKey=\"" + _xml.escapeXml(changeKey || "") + "\"/>" +
    "<t:Sender><t:Mailbox><t:EmailAddress>" + _xml.escapeXml(attendeeEmail || "") + "</t:EmailAddress>" +
    "</t:Mailbox></t:Sender>" +
    "</t:" + elementName + "></m:Items>" +
    "</m:CreateItem>";
  return _xml.soapEnvelope(body);
}

// --- small utilities ---------------------------------------------------------

function stripHtml(html) {
  if (!html) {
    return "";
  }
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Node test export (ignored in Thunderbird where `module` is undefined).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NS: NS,
    cleanSmtp: cleanSmtp,
    calendarFolderIdXml: calendarFolderIdXml,
    itemShapeXml: itemShapeXml,
    tzXml: tzXml,
    buildFindFolder: buildFindFolder,
    parseFindFolder: parseFindFolder,
    buildFindItemCalendarView: buildFindItemCalendarView,
    parseCalendarItem: parseCalendarItem,
    parseFindItem: parseFindItem,
    buildSyncFolderItems: buildSyncFolderItems,
    parseSync: parseSync,
    buildGetItem: buildGetItem,
    parseGetItem: parseGetItem,
    calendarItemXml: calendarItemXml,
    splitAttendees: splitAttendees,
    buildCreateItem: buildCreateItem,
    parseCreateItem: parseCreateItem,
    buildUpdateItem: buildUpdateItem,
    buildDeleteItem: buildDeleteItem,
    buildResolveNames: buildResolveNames,
    parseResolveNames: parseResolveNames,
    buildRespondMeeting: buildRespondMeeting,
    stripHtml: stripHtml,
  };
}
