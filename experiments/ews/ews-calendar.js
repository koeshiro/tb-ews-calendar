"use strict";
// ews-calendar.js — the "ews" calICalendar provider: Exchange via EWS,
// backed by CalStorageCalendar (SQLite in <profile>/calendar-data).
//
// Items live in the storage DB with id "ews:<EWS ItemId>"; per-item EWS
// metadata (changeKey, organizer, meetingRequestType) lives in the storage
// metadata table keyed by the raw EWS ItemId. The delta-sync state is kept
// under the metadata key "ews-sync-state".
//
// Local CRUD (UI edits) is pushed to the server FIRST and only persisted via
// the storage super class on success. Server deltas are applied in batches.
//
// Globals injected by loader.js: cal, CalStorageCalendar, Cc, Ci, Cr,
// Components, ChromeUtils, setTimeout; require("./...") resolves lib + modules.

var _client = require("./ews-client.js");
var _xml = require("./ews-xml.js");
var _dt = require("./ews-datetime.js");
var _item = require("./ews-item.js");
var _sync = require("./ews-sync.js");
var _transport = require("./ews-transport.js");
var _config = require("./ews-config.js");

// CalStorageCalendar's id/uri accessors and getProperty walk
// this.__proto__.__proto__ — that assumes the instance's prototype IS
// CalStorageCalendar.prototype and therefore loops forever on an ES6
// subclass. Shadow them here with explicit calls to the BaseClass
// accessors plus the storage-specific logic (once-only uri, DB init).
var BASE_PROTO = cal.provider.BaseClass.prototype;
var BASE_ID = Object.getOwnPropertyDescriptor(BASE_PROTO, "id");
var BASE_URI = Object.getOwnPropertyDescriptor(BASE_PROTO, "uri");

class EwsCalendar extends CalStorageCalendar {
  // BaseClass reads this.constructor.mTransientProperties — on a subclass
  // that is EwsCalendar, so delegate to the BaseClass static.
  static get mTransientProperties() {
    return cal.provider.BaseClass.mTransientProperties;
  }

  QueryInterface = ChromeUtils.generateQI([
    "calICalendar",
    "calISchedulingSupport",
    "calICalendarProvider",
    "calIOfflineStorage",
    "calISyncWriteCalendar",
  ]);

  constructor() {
    super();
    this._syncing = false;
  }

  // --- identity -------------------------------------------------------------

  get type() {
    return "ews";
  }

  // --- id/uri: BaseClass accessors + storage's prepareInitDB logic ----------

  get id() {
    return BASE_ID.get.call(this);
  }
  set id(val) {
    BASE_ID.set.call(this, val);
    if (!this.mStorageDb && this.uri && this.id) {
      this.prepareInitDB();
    }
  }

  get uri() {
    return BASE_URI.get.call(this);
  }
  set uri(aUri) {
    if (this.uri) {
      throw Components.Exception("", Cr.NS_ERROR_FAILURE);
    }
    BASE_URI.set.call(this, aUri);
    if (!this.mStorageDb && this.uri && this.id) {
      this.prepareInitDB();
    }
  }

  // Storage's getProperty switch, with an explicit BaseClass fallback
  // instead of the looping __proto__ walk.
  getProperty(aName) {
    switch (aName) {
      case "cache.supported":
        return false;
      case "requiresNetwork":
        return false;
      case "capabilities.priority.supported":
        return true;
      case "capabilities.removeModes":
        return ["delete"];
    }
    return BASE_PROTO.getProperty.call(this, aName);
  }

  get displayName() {
    return "Exchange (EWS)";
  }

  get shortName() {
    return "EWS";
  }

  get canRefresh() {
    return true;
  }

  detectCalendars() {
    throw Components.Exception(
      "ews: detectCalendars is not supported",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  async deleteCalendar() {
    await super.deleteCalendar();
    try {
      this.deleteMetaData("ews-sync-state");
    } catch (e) {}
  }

  // Refresh is driven by the calendar manager's refresh timer; it reads the
  // "refreshInterval" property (minutes) at calendar setup.
  refresh() {
    this.syncFromServer().catch(e => console.error("ews: refresh failed", e));
  }

  // --- config ---------------------------------------------------------------

  get _cfg() {
    return _config.getProps(this);
  }

  // Wait until the storage models exist (id+uri set and the async DB upgrade
  // has run). Polls briefly; resolves anyway after maxMs so sync errors are
  // visible instead of silently swallowed.
  _dbReady(maxMs) {
    maxMs = maxMs || 30000;
    if (this.mMetaModel && this.mItemModel) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      var t0 = Date.now();
      var tick = () => {
        if ((this.mMetaModel && this.mItemModel) || Date.now() - t0 > maxMs) {
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  // --- EWS plumbing -----------------------------------------------------------

  // Post a SOAP envelope and normalize to { ok, httpCode, id, changeKey, error }.
  async _post(body) {
    var r = await _transport.post(body, this._cfg);
    if (!r.doc) {
      return { ok: false, httpCode: r.httpCode, error: r.error || "HTTP " + r.httpCode };
    }
    var st = _xml.responseStatus(r.doc);
    if (!st.ok) {
      return {
        ok: false,
        httpCode: r.httpCode,
        error: (st.code || "error") + " " + (st.message || ""),
      };
    }
    var idEl = _xml.findDesc(r.doc, "t:ItemId");
    return {
      ok: true,
      httpCode: r.httpCode,
      id: idEl ? _xml.attr(idEl, "Id") : null,
      changeKey: idEl ? _xml.attr(idEl, "ChangeKey") : null,
    };
  }

  _ewsIdOf(evt) {
    var id = null;
    try {
      id = evt.getProperty("ews-itemId");
    } catch (e) {}
    if (!id && typeof evt.id === "string" && evt.id.indexOf("ews:") === 0) {
      id = evt.id.substring(4);
    }
    return id || null;
  }

  _metaOf(ewsId) {
    if (!ewsId) {
      return null;
    }
    try {
      var raw = this.getMetaData(ewsId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  _saveMeta(ewsId, meta) {
    try {
      this.setMetaData(ewsId, JSON.stringify(meta));
    } catch (e) {
      console.error("ews: failed to save item metadata", e);
    }
  }

  _fail(message) {
    this.notifyError(Cr.NS_ERROR_FAILURE, message);
    throw Components.Exception(message, Cr.NS_ERROR_FAILURE);
  }

  // --- calICalendar: local edits push to the server ----------------------------

  // UI "new event" -> CreateItem (+ meeting invitations).
  async adoptItem(aItem) {
    var cfg = this._cfg;
    if (!cfg.url) {
      return this._fail("ews: calendar is not configured");
    }
    if (this.readOnly) {
      return this._fail("Calendar is readonly");
    }
    var item = _item.calEventToItem(aItem, {});
    var isMeeting = item.attendees && item.attendees.length > 0;
    var body = _client.buildCreateItem(item, { isMeeting: isMeeting, sendInvites: true, tz: null });
    var r = await this._post(body);
    if (!r.ok || !r.id) {
      return this._fail("ews: create failed: " + (r.error || "no item id"));
    }
    item.id = r.id;
    item.changeKey = r.changeKey || "";
    this._saveMeta(r.id, {
      changeKey: item.changeKey,
      organizer: item.organizer || cfg.email,
      meetingRequestType: item.meetingRequestType || "",
    });
    var stored = _item.itemToCalEvent(item, this);
    return await super.adoptItem(stored);
  }

  // UI edit -> UpdateItem with SetItemField changes.
  async modifyItem(aNewItem, aOldItem) {
    var cfg = this._cfg;
    if (!cfg.url) {
      return this._fail("ews: calendar is not configured");
    }
    if (this.readOnly) {
      return this._fail("Calendar is readonly");
    }
    var ewsId = this._ewsIdOf(aNewItem) || this._ewsIdOf(aOldItem);
    var meta = this._metaOf(ewsId);
    if (!ewsId || !meta || !meta.changeKey) {
      return this._fail("ews: item has no server metadata — run a sync first");
    }
    var item = _item.calEventToItem(aNewItem, {
      id: ewsId,
      changeKey: meta.changeKey,
      organizer: meta.organizer,
      meetingRequestType: meta.meetingRequestType,
    });
    var isMeeting = !!meta.meetingRequestType || (item.attendees && item.attendees.length > 0);
    var changes = [
      { field: "Subject", valueXml: "<t:Subject>" + _xml.escapeXml(item.subject || "") + "</t:Subject>" },
      { field: "Body", valueXml: "<t:Body BodyType=\"Text\">" + _xml.escapeXml(item.bodyText || "") + "</t:Body>" },
      { field: "Start", valueXml: "<t:Start>" + _xml.escapeXml(item.startISO || "") + "</t:Start>" },
      { field: "End", valueXml: "<t:End>" + _xml.escapeXml(item.endISO || "") + "</t:End>" },
      {
        field: "IsAllDayEvent",
        valueXml: "<t:IsAllDayEvent>" + (item.isAllDay ? "true" : "false") + "</t:IsAllDayEvent>",
      },
      { field: "Location", valueXml: "<t:Location>" + _xml.escapeXml(item.location || "") + "</t:Location>" },
    ];
    var atts = _client.splitAttendees(item.attendees);
    if (atts.required) {
      changes.push({ field: "RequiredAttendees", valueXml: "<t:RequiredAttendees>" + atts.required + "</t:RequiredAttendees>" });
    }
    if (atts.optional) {
      changes.push({ field: "OptionalAttendees", valueXml: "<t:OptionalAttendees>" + atts.optional + "</t:OptionalAttendees>" });
    }
    var body = _client.buildUpdateItem(ewsId, meta.changeKey, changes, {
      isMeeting: isMeeting,
      sendInvites: true,
    });
    var r = await this._post(body);
    if (!r.ok) {
      return this._fail("ews: update failed: " + r.error);
    }
    var newKey = r.changeKey || meta.changeKey;
    this._saveMeta(ewsId, Object.assign({}, meta, { changeKey: newKey }));
    try {
      aNewItem.setProperty("ews-changeKey", newKey);
    } catch (e) {}
    return await super.modifyItem(aNewItem, aOldItem);
  }

  // UI delete -> SoftDelete (+ cancellation for meetings).
  async deleteItem(aItem) {
    var cfg = this._cfg;
    if (!cfg.url) {
      return this._fail("ews: calendar is not configured");
    }
    if (this.readOnly) {
      return this._fail("Calendar is readonly");
    }
    var ewsId = this._ewsIdOf(aItem);
    var meta = this._metaOf(ewsId);
    if (!ewsId || !meta) {
      return this._fail("ews: item has no server metadata — run a sync first");
    }
    var isMeeting = !!meta.meetingRequestType || (meta.organizer || "") === cfg.email;
    var body = _client.buildDeleteItem(ewsId, meta.changeKey, {
      isMeeting: isMeeting,
      sendInvites: true,
    });
    var r = await this._post(body);
    if (!r.ok) {
      return this._fail("ews: delete failed: " + r.error);
    }
    try {
      this.deleteMetaData(ewsId);
    } catch (e) {}
    return await super.deleteItem(aItem);
  }

  // --- server -> store sync ----------------------------------------------------

  async syncFromServer() {
    if (this._syncing) {
      return { ok: false, busy: true, error: "sync already running" };
    }
    var cfg = this._cfg;
    if (!cfg.url) {
      return { ok: false, error: "calendar is not configured" };
    }
    this._syncing = true;
    try {
      await this._dbReady();
      var r = await _sync.runSync(cfg, {});
      if (!r.ok) {
        _config.setSyncStatus(this, false, r.error);
        console.warn("ews: sync failed for '" + this.name + "': " + r.error);
        return r;
      }
      await this.applyWindowSync(r.windowStartISO, r.windowEndISO, r.items);
      _config.setSyncStatus(this, true, null, r.items.length);
      this.observers.notify("onLoad", [this.superCalendar]);
      console.info(
        "ews: sync ok for '" + this.name + "': " + r.items.length + " item(s) in window"
      );
      return r;
    } catch (e) {
      _config.setSyncStatus(this, false, String(e));
      console.error("ews: sync error for '" + this.name + "'", e);
      return { ok: false, error: String(e) };
    } finally {
      this._syncing = false;
    }
  }

  // Apply a windowed FindItem result: upsert fetched items, then remove
  // local ews items whose start lies inside the window but which the server
  // no longer returns (deleted / moved out). Items outside the window are
  // left untouched.
  async applyWindowSync(windowStartISO, windowEndISO, fetchedItems) {
    var windowStartPR = _dt.isoToPRTime(windowStartISO);
    var windowEndPR = _dt.isoToPRTime(windowEndISO);
    this.startBatch();
    try {
      var fetchedIds = {};
      var items = fetchedItems || [];
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (!it.id) {
          continue;
        }
        fetchedIds["ews:" + it.id] = true;
        var evt = _item.itemToCalEvent(it, this);
        var oldItem = await super.getItem(evt.id);
        if (oldItem) {
          try {
            evt.generation = oldItem.generation;
          } catch (e) {}
          await super.modifyItem(evt, oldItem);
        } else {
          await super.adoptItem(evt);
        }
        this._saveMeta(it.id, {
          changeKey: it.changeKey || "",
          organizer: it.organizer || "",
          meetingRequestType: it.meetingRequestType || "",
        });
      }

      // Removals: every metadata id not in the fetched set. The metadata
      // table doubles as our local index of ews ids.
      var metaIds = [];
      try {
        metaIds = this.getAllMetaDataIds() || [];
      } catch (e) {}
      for (var k = 0; k < metaIds.length; k++) {
        var ewsId = typeof metaIds[k] === "object" && metaIds[k] ? metaIds[k].id : metaIds[k];
        if (!ewsId || ewsId === "ews-sync-state" || fetchedIds["ews:" + ewsId]) {
          continue;
        }
        var calId = "ews:" + ewsId;
        var old;
        try {
          old = await super.getItem(calId);
        } catch (e) {
          old = null;
        }
        if (!old) {
          try {
            this.deleteMetaData(ewsId);
          } catch (e) {}
          continue;
        }
        var st = old.startDate ? old.startDate.nativeTime : 0;
        if (st >= windowStartPR && st < windowEndPR) {
          try {
            this.deleteMetaData(ewsId);
          } catch (e) {}
          await super.deleteItem(old);
        }
      }
    } finally {
      this.endBatch();
    }
  }

  // --- meeting response ---------------------------------------------------------

  // response: "Accept" | "Tentative" | "Decline"
  async respondToMeeting(ewsId, response) {
    var cfg = this._cfg;
    var meta = this._metaOf(ewsId);
    if (!meta || !meta.changeKey) {
      return { ok: false, error: "ews: item has no server metadata — run a sync first" };
    }
    var body = _client.buildRespondMeeting(ewsId, meta.changeKey, cfg.email, response);
    var r = await this._post(body);
    if (r.ok && r.changeKey) {
      this._saveMeta(ewsId, Object.assign({}, meta, { changeKey: r.changeKey }));
      await this.syncFromServer();
    }
    return { ok: r.ok, error: r.error || null };
  }
}

module.exports = { EwsCalendar: EwsCalendar };
