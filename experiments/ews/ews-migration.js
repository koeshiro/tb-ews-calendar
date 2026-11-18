"use strict";
// ews-migration.js — one-time upgrade from the 0.1.x bootstrap add-on prefs.
// Old layout: "extensions.tb-ews-calendar.calendars" (CSV of ids) plus
// "extensions.tb-ews-calendar.cal.<id>.{url,email,displayName,authMethod,
// password,syncIntervalMin,folderId,syncState,readOnly}". New layout: a real
// calendar of type "ews" with the SAME id, config in calendar properties and
// the sync state in the storage metadata table. The old branch is cleared.
//
// Globals injected by loader.js: Services, cal; require("./ews-config.js").

var BRANCH = "extensions.tb-ews-calendar.";

function run() {
  var listPref = BRANCH + "calendars";
  var csv;
  try {
    csv = Services.prefs.getStringPref(listPref, "");
  } catch (e) {
    csv = "";
  }
  if (!csv) {
    return;
  }
  var mgr = cal.manager;
  var migrated = 0;
  var ids = csv
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  for (var i = 0; i < ids.length; i++) {
    var oldId = ids[i];
    var b = BRANCH + "cal." + oldId + ".";
    function g(key, dflt) {
      try {
        return Services.prefs.getStringPref(b + key) || dflt || "";
      } catch (e) {
        return dflt || "";
      }
    }
    var url = g("url");
    if (!url) {
      continue;
    }
    var configMod = require("./ews-config.js");
    try {
      var uri = Services.io.newURI("ews://" + encodeURIComponent(g("email") || oldId));
      var calObj = mgr.createCalendar("ews", uri);
      if (!calObj) {
        continue;
      }
      calObj.id = oldId; // keep the old calendar id for continuity
      try {
        calObj.name = g("displayName") || g("email") || "Exchange";
      } catch (e) {}
      configMod.setProps(calObj, {
        url: url,
        email: g("email"),
        authMethod: g("authMethod") || "auto",
        password: configMod.decryptPassword(g("password")),
        refreshInterval: g("syncIntervalMin") || 30,
        folderId: g("folderId"),
        readOnly: g("readOnly") === "true",
      });
      var syncState = g("syncState");
      if (syncState && calObj.wrappedJSObject) {
        try {
          calObj.wrappedJSObject.setMetaData("ews-sync-state", syncState);
        } catch (e) {}
      }
      try {
        mgr.registerCalendar(calObj);
        migrated++;
      } catch (e) {
        console.error("ews migration: registerCalendar failed for " + oldId, e);
      }
    } catch (e) {
      console.error("ews migration: failed for " + oldId, e);
      continue;
    }
    try {
      Services.prefs.deleteBranch(b);
    } catch (e) {}
  }
  try {
    Services.prefs.deleteBranch(listPref);
  } catch (e) {}
  if (migrated) {
    console.info("ews migration: migrated " + migrated + " calendar(s) from 0.1.x prefs");
  }
}

module.exports = { run: run };
