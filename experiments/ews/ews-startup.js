"use strict";
// ews-startup.js — provider registration + lifecycle.
// startup(): heal composite-visibility prefs, then DEFER registration until
// the first mail window is fully loaded, then register the EwsCalendar class
// as calendar type "ews", run the legacy prefs migration and kick off an
// initial sync. shutdown(): unregister the provider.
//
// Two timing rules, both to keep TB's calendar UI out of crash-prone early
// notification cascades:
// 1. Composite visibility (calendar-main-in-composite) is written DIRECTLY
//    to registry prefs at experiment startup. BaseClass.getProperty lazily
//    reads registry prefs, so the window composite's standard populate picks
//    it up like any native calendar — a calendar.setProperty here instead
//    fires observer notifications (composite -> task editor -> list) that
//    crash while the UI is still initializing (getSelectedCalendar() null,
//    "item is undefined" in loadCalendarManager).
// 2. registerCalendarProvider internally runs updateDummyCalendarRegistration,
//    whose notifications reach open windows; registration therefore waits for
//    document.readyState === "complete" (+ settle delay).
//
// Globals injected by loader.js: cal, CalStorageCalendar, Services, console.

function startup(version) {
  healCompositePrefs();

  var registered = false;

  var register = function () {
    if (registered) {
      return;
    }
    registered = true;
    var mgr = cal.manager;
    var ewsMod = require("./ews-calendar.js");

    // registerCalendarProvider throws if the type already exists (add-on reload).
    if (mgr.hasCalendarProvider("ews")) {
      try {
        mgr.unregisterCalendarProvider("ews", true);
      } catch (e) {
        console.error("ews: unregister failed during re-registration", e);
      }
    }
    mgr.registerCalendarProvider("ews", ewsMod.EwsCalendar);
    // The version stamp identifies the build actually running in this session —
    // a reinstall that didn't take would otherwise be invisible in the log.
    console.info("ews: calendar provider type 'ews' registered (addon v" + (version || "?") + ")");

    try {
      require("./ews-migration.js").run();
    } catch (e) {
      console.error("ews: migration failed", e);
    }

    syncAll();
  };

  var syncAll = function () {
    var cals = [];
    try {
      cals = cal.manager.getCalendars();
    } catch (e) {
      return;
    }
    for (var i = 0; i < cals.length; i++) {
      var c = cals[i];
      if (c.type !== "ews" || c.getProperty("disabled")) {
        continue;
      }
      // Fallback for calendars the pref heal missed (e.g. stale in-memory
      // property caches). setProperty skips notifications when the value is
      // unchanged, and at this point the windows are fully loaded anyway.
      try {
        if (c.getProperty("calendar-main-in-composite") !== true) {
          c.setProperty("calendar-main-in-composite", true);
        }
      } catch (e) {}
      var w = c.wrappedJSObject;
      if (w && w.syncFromServer) {
        w.syncFromServer().catch(function (e) {
          console.error("ews: initial sync failed", e);
        });
      }
    }
  };

  var attempts = 0;
  var waitReady = function () {
    var win = null;
    try {
      win = Services.wm.getMostRecentWindow("mail:3pane");
    } catch (e) {}
    if (win && win.document && win.document.readyState === "complete") {
      // Settle delay: async calendar-list/filter init (getItems streams) may
      // still be draining right after readyState flips to complete.
      setTimeout(register, 500);
      return;
    }
    // Safety: register anyway after ~60s without a loaded mail window.
    if (++attempts > 120) {
      register();
      return;
    }
    setTimeout(waitReady, 500);
  };
  setTimeout(waitReady, 500);
}

// Mirror TB's own semantics: only fill in an UNSET value, respect an explicit
// "hidden" choice (prefHasUserValue with false).
function healCompositePrefs() {
  try {
    var names = Services.prefs.getChildList("calendar.registry.");
    var ids = {};
    for (var i = 0; i < names.length; i++) {
      var m = /^calendar\.registry\.([^.]+)\.(.+)$/.exec(names[i]);
      if (m) {
        ids[m[1]] = true;
      }
    }
    for (var id in ids) {
      if (Services.prefs.getStringPref("calendar.registry." + id + ".type", "") !== "ews") {
        continue;
      }
      var p = "calendar.registry." + id + ".calendar-main-in-composite";
      if (!Services.prefs.prefHasUserValue(p)) {
        Services.prefs.setBoolPref(p, true);
        console.info("ews: composite visibility pref set for calendar " + id);
      }
    }
  } catch (e) {
    console.error("ews: composite pref heal failed", e);
  }
}

function shutdown() {
  try {
    cal.manager.unregisterCalendarProvider("ews", true);
  } catch (e) {}
}

module.exports = { startup: startup, shutdown: shutdown };
