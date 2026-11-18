"use strict";
// loader.js — plain-script bootstrap for the ews experiment internals.
// Loaded via loadSubScript from api.js; `this` (the target scope object)
// receives setBaseURL / requireLib / requireModule. lib/*.js are written for
// Node's `require`, so each file is evaluated with a fresh
// { module, exports, require } injected; results are cached and shared.

(function (exports) {
  // `Services`, `Cc`, `Ci`, `Cr`, `Cu`, `ChromeUtils` are plain globals of
  // the api sandbox (there is no Services.sys.mjs in current Gecko).
  // Only Timer.sys.mjs still needs importing.
  var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs"
  );
  var calEventMod = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");
  var calAttendeeMod = ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs");
  var calUtilsMod = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

  // Add the web/encoding constructors to the sandbox global so bare
  // identifiers (XMLHttpRequest, DOMParser, ...) resolve in every
  // loadSubScript'ed module. importGlobalProperties installs the REAL
  // chrome constructors — no cross-realm shims needed.
  try {
    Cu.importGlobalProperties([
      "XMLHttpRequest",
      "DOMParser",
      "TextEncoder",
      "TextDecoder",
      "fetch",
      "atob",
      "btoa",
    ]);
  } catch (e) {
    console.error("ews: importGlobalProperties failed", e);
  }

  // The sandbox has Cc/Ci/Cr/Cu as globals but NOT `Components`. Provide
  // the real one when present, else a small shim so that
  // Components.Exception(msg, code) keeps working in lib modules.
  var COMP = typeof Components !== "undefined" ? Components : {
    classes: typeof Cc !== "undefined" ? Cc : null,
    interfaces: typeof Ci !== "undefined" ? Ci : null,
    results: typeof Cr !== "undefined" ? Cr : null,
    utils: typeof Cu !== "undefined" ? Cu : null,
    Exception: function (message, result) {
      var e = new Error(message || String(result || ""));
      e.result = result || (typeof Cr !== "undefined" ? Cr.NS_ERROR_FAILURE : 0x80004005);
      return e;
    },
  };

  var DUMP = typeof dump !== "undefined" ? dump : function () {};

  var LIB_NAMES = new Set([
    "ews-client", "ews-xml", "ews-datetime", "ews-item", "ews-sync", "ews-transport", "ews-ntlm",
  ]);
  var CACHE = Object.create(null);
  var BASE_URL = null;

  exports.setBaseURL = function (url) {
    BASE_URL = url.endsWith("/") ? url : url + "/";
  };

  function baseScope(extra) {
    return Object.assign(
      {
        module: null,
        exports: null,
        require: null,
        ChromeUtils: ChromeUtils,
        Components: COMP,
        Cc: typeof Cc !== "undefined" ? Cc : null,
        Ci: typeof Ci !== "undefined" ? Ci : null,
        Cr: typeof Cr !== "undefined" ? Cr : null,
        Cu: typeof Cu !== "undefined" ? Cu : null,
        Services: Services,
        console: console,
        dump: DUMP,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        CalEvent: calEventMod.CalEvent,
        CalAttendee: calAttendeeMod.CalAttendee,
        cal: calUtilsMod.cal,
      },
      extra
    );
  }

  function loadOnce(key, url, makeScope) {
    if (CACHE[key]) {
      return CACHE[key];
    }
    if (!BASE_URL) {
      throw new Error("ews: base URL not set; call setBaseURL() first");
    }
    var moduleObj = { exports: {} };
    Services.scriptloader.loadSubScriptWithOptions(url, {
      target: makeScope(moduleObj),
      charset: "UTF-8",
      // lib/*.js live inside the extension (moz-extension:// URLs).
      allowUnsafeURL: true,
      // The subscript cache keys by URL; the extension UUID survives
      // reinstalls, so ignore it to always read the current files.
      ignoreCache: true,
    });
    CACHE[key] = moduleObj.exports;
    return CACHE[key];
  }

  function requireDispatch(relName) {
    var name = String(relName).replace(/^\.\//, "").replace(/\.js$/, "");
    return LIB_NAMES.has(name) ? exports.requireLib(name) : exports.requireModule(name);
  }

  // Dual-mode lib modules (ews-client, ews-xml, ...).
  exports.requireLib = function (relName) {
    var name = String(relName).replace(/^\.\//, "").replace(/\.js$/, "");
    return loadOnce("lib:" + name, BASE_URL + "lib/" + name + ".js", function (moduleObj) {
      return baseScope({
        module: moduleObj,
        exports: moduleObj.exports,
        require: requireDispatch,
      });
    });
  };

  // Experiment-internal modules (ews-calendar, ews-config, ...) — these get
  // the Thunderbird calendar globals injected on top.
  exports.requireModule = function (name) {
    return loadOnce("mod:" + name, BASE_URL + "experiments/ews/" + name + ".js", function (
      moduleObj
    ) {
      var calUtils = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
      var storage = ChromeUtils.importESModule("resource:///modules/CalStorageCalendar.sys.mjs");
      return baseScope({
        module: moduleObj,
        exports: moduleObj.exports,
        require: requireDispatch,
        cal: calUtils.cal,
        CalStorageCalendar: storage.CalStorageCalendar,
      });
    });
  };
})(this);
