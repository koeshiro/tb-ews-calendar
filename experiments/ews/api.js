"use strict";
/* api.js — the "ews" experiment API implementation.
 * Loaded by the WebExtension framework as a parent-process script; `exports`
 * and ExtensionCommon are provided by that scope.
 *
 * The internals (loader, provider, config) are plain scripts loaded through
 * experiments/ews/loader.js so they can reuse the Node-tested lib/*.js.
 */

(function (exports) {
  // In this sandbox `Services`, `Ci`, `ChromeUtils` and `ExtensionAPI` are
  // provided as globals by ExtensionCommon's _createExtGlobal(). Note: there
  // is no resource://gre/modules/Services.sys.mjs anymore — Services is only
  // available as a global.
  var CI = typeof Ci !== "undefined" && Ci ? Ci : null;

  var CORE = null;

  function ensureCore(api) {
    if (CORE) {
      return CORE;
    }
    var core = {};
    // extension.getURL() returns a plain string ("moz-extension://uuid/path").
    // moz-extension:// is blocked by the subscript loader unless
    // allowUnsafeURL is set (the same thing ExtensionCommon does for
    // experiment_apis).
    Services.scriptloader.loadSubScriptWithOptions(
      api.extension.getURL("experiments/ews/loader.js"),
      { target: core, allowUnsafeURL: true, ignoreCache: true }
    );
    core.setBaseURL(api.extension.getURL(""));
    CORE = core;
    return core;
  }

  function calUtils() {
    return ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  }

  exports.ews = class extends ExtensionCommon.ExtensionAPI {
    onStartup() {
      console.info(
        "ews: experiment api.js onStartup, extension=" +
          this.extension.id +
          " v" +
          this.extension.manifest.version
      );
      try {
        var core = ensureCore(this);
        // Registration itself is deferred until the first mail window exists
        // (see ews-startup.js) — this only kicks the wait loop off.
        core.requireModule("ews-startup").startup(this.extension.manifest.version);
        console.info("ews: startup initiated (provider registers after first window)");
      } catch (e) {
        console.error("ews: onStartup failed", e);
      }
    }

    onShutdown(isAppShutdown) {
      if (!isAppShutdown && CORE) {
        try {
          CORE.requireModule("ews-startup").shutdown();
        } catch (e) {}
        // Required when unloaded for a non-shutdown reason (add-on reload):
        // otherwise stale experiment files stay in the startup cache.
        Services.obs.notifyObservers(null, "startupcache-invalidate");
      }
      CORE = null;
    }

    _byId(id) {
      var cals = calUtils().cal.manager.getCalendars();
      for (var i = 0; i < cals.length; i++) {
        if (cals[i].id === id) {
          return cals[i];
        }
      }
      return null;
    }

    _infoOf(calObj) {
      var w = calObj.wrappedJSObject || calObj;
      var cfg = CORE.requireModule("ews-config").getProps(w);
      return {
        id: calObj.id,
        name: String(calObj.name || ""),
        url: cfg.url,
        email: cfg.email,
        authMethod: cfg.authMethod,
        refreshInterval: cfg.refreshInterval,
        readOnly: cfg.readOnly,
        hasPassword: !!cfg.password,
        lastSyncOk: cfg.lastSyncOk,
        lastSyncError: cfg.lastSyncError,
        lastSyncTime: cfg.lastSyncTime,
        lastSyncCount: cfg.lastSyncCount,
      };
    }

    getAPI() {
      // Arrow functions keep `this` bound to the ExtensionAPI instance.
      return {
        ews: {
          listCalendars: async () => {
            ensureCore(this);
            var cals = calUtils().cal.manager.getCalendars().filter(c => c.type === "ews");
            return cals.map(c => this._infoOf(c));
          },

          createCalendar: async config => {
            ensureCore(this);
            var { cal } = calUtils();
            var configMod = CORE.requireModule("ews-config");
            if (!config || !config.url || !config.email) {
              return { error: "url and email are required" };
            }
            var uri = Services.io.newURI("moz-storage-calendar://");
            var calObj = cal.manager.createCalendar("ews", uri);
            if (!calObj) {
              return { error: "provider is not registered" };
            }
            calObj.id = cal.getUUID();
            configMod.setProps(calObj, {
              url: config.url,
              email: config.email,
              displayName: config.displayName,
              authMethod: config.authMethod,
              password: config.password,
              refreshInterval: config.refreshInterval,
              readOnly: config.readOnly,
            });
            cal.manager.registerCalendar(calObj);
            // Calendar views only include calendars with this property. The
            // composite auto-adds registered calendars (setting it) only via
            // its onCalendarRegistered hook, which fires just while a window
            // is open — our calendars register before any window exists.
            calObj.setProperty("calendar-main-in-composite", true);
            var w = calObj.wrappedJSObject;
            if (w && w.syncFromServer) {
              w.syncFromServer().catch(() => {});
            }
            return { id: calObj.id };
          },

          updateCalendar: async (calendarId, config) => {
            ensureCore(this);
            var { cal } = calUtils();
            var calObj = this._byId(calendarId);
            if (!calObj) {
              return { ok: false, error: "calendar not found: " + calendarId };
            }
            var configMod = CORE.requireModule("ews-config");
            var prevInterval = String(calObj.getProperty("refreshInterval"));
            configMod.setProps(calObj.wrappedJSObject || calObj, config || {});
            var newInterval = String(calObj.getProperty("refreshInterval"));
            if (prevInterval !== newInterval) {
              // The manager re-reads "refreshInterval" only during setup.
              cal.manager.updateCalendarRegistration([calObj]);
            }
            return { ok: true };
          },

          removeCalendar: async calendarId => {
            ensureCore(this);
            var { cal } = calUtils();
            var calObj = this._byId(calendarId);
            if (!calObj) {
              return { ok: false, error: "calendar not found: " + calendarId };
            }
            cal.manager.unregisterCalendar(calObj);
            return { ok: true };
          },

          syncNow: async calendarId => {
            ensureCore(this);
            var cals = calUtils()
              .cal.manager.getCalendars()
              .filter(c => c.type === "ews");
            if (calendarId) {
              cals = cals.filter(c => c.id === calendarId);
              if (!cals.length) {
                return { ok: false, error: "calendar not found: " + calendarId };
              }
            }
            var firstError = null;
            var ok = true;
            for (var i = 0; i < cals.length; i++) {
              var w = cals[i].wrappedJSObject;
              if (!w || !w.syncFromServer) {
                continue;
              }
              var r = await w.syncFromServer();
              if (!r.ok || r.busy) {
                if (!r.ok) {
                  ok = false;
                }
                firstError = firstError || r.error;
              }
            }
            return { ok: ok, error: ok ? null : firstError || "sync failed" };
          },

          testConnection: async (config, calendarId) => {
            ensureCore(this);
            var client = CORE.requireLib("./ews-client.js");
            var xml = CORE.requireLib("./ews-xml.js");
            var transport = CORE.requireLib("./ews-transport.js");
            var cfg = Object.assign({}, config || {});
            if (calendarId && (!cfg.password || !cfg.email || !cfg.url)) {
              var calObj = this._byId(calendarId);
              if (calObj) {
                var stored = CORE.requireModule("ews-config").getProps(calObj.wrappedJSObject || calObj);
                if (!cfg.url) {
                  cfg.url = stored.url;
                }
                if (!cfg.email) {
                  cfg.email = stored.email;
                }
                if (!cfg.password) {
                  cfg.password = stored.password;
                }
              }
            }
            if (!cfg.url) {
              return { ok: false, httpCode: 0, error: "url is required" };
            }
            var body = client.buildFindFolder();
            var r = await transport.post(body, cfg);
            var result = { ok: false, httpCode: r.httpCode, error: null, authPath: r.authPath || null };
            if (r.httpCode !== 0 && !r.doc) {
              result.error = r.error || "non-XML response (HTTP " + r.httpCode + ")";
              return result;
            }
            if (!r.doc) {
              result.error = r.error || "no response";
              return result;
            }
            var st = xml.responseStatus(r.doc);
            if (!st.ok) {
              result.error = (st.code || "error") + " " + (st.message || "");
              return result;
            }
            result.ok = true;
            return result;
          },

          getSelectedEvent: async () => {
            ensureCore(this);
            var win = Services.wm.getMostRecentWindow("mail:3pane");
            if (!win) {
              return null;
            }
            // Only the calendar tab hosts a calendar view.
            try {
              var tabmail = win.tabmail;
              var tab = tabmail && tabmail.currentTabInfo;
              if (!tab || !tab.mode || (tab.mode.name !== "calendar" && tab.mode.name !== "calendarTask")) {
                return null;
              }
            } catch (e) {
              return null;
            }
            var items = [];
            try {
              items = win.getSelectedItems() || [];
            } catch (e) {
              items = [];
            }
            if (!items.length) {
              try {
                var view = win.currentView();
                items = view ? view.getSelectedItems() : [];
              } catch (e) {
                items = [];
              }
            }
            var evt = null;
            for (var i = 0; i < items.length; i++) {
              var it = items[i];
              try {
                it.QueryInterface(CI.calIEvent);
                evt = it;
                break;
              } catch (e) {}
            }
            if (!evt) {
              return null;
            }
            var calObj = null;
            try {
              calObj = evt.calendar && evt.calendar.superCalendar;
            } catch (e) {}
            if (!calObj || calObj.type !== "ews") {
              return null;
            }
            var itemId = null;
            var organizer = "";
            try {
              itemId = evt.getProperty("ews-itemId") || null;
              organizer = String(evt.getProperty("ews-organizer") || "");
            } catch (e) {}
            if (!itemId && typeof evt.id === "string" && evt.id.indexOf("ews:") === 0) {
              itemId = evt.id.substring(4);
            }
            var cfg = this._infoOf(calObj);
            var dtMod = CORE.requireLib("./ews-datetime.js");
            var info = {
              calendarId: calObj.id,
              calendarName: String(calObj.name || ""),
              title: String(evt.title || ""),
              startISO: evt.startDate ? dtMod.prTimeToISO(evt.startDate.nativeTime) : "",
              endISO: evt.endDate ? dtMod.prTimeToISO(evt.endDate.nativeTime) : "",
              isInvitation:
                !!itemId &&
                !!cfg.email &&
                !!organizer &&
                organizer.toLowerCase() !== cfg.email.toLowerCase(),
            };
            if (itemId) {
              info.itemId = itemId;
            }
            return info;
          },

          respondToMeeting: async (calendarId, itemId, response) => {
            ensureCore(this);
            var calObj = this._byId(calendarId);
            var w = calObj && calObj.wrappedJSObject;
            if (!w || !w.respondToMeeting) {
              return { ok: false, error: "calendar not found: " + calendarId };
            }
            return await w.respondToMeeting(itemId, response);
          },
        },
      };
    }
  };
})(this);
