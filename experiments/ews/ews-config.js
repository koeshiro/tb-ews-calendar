"use strict";
// ews-config.js — calendar property schema + Secret Decoder Ring passwords.
// Config lives in calICalendar properties, which cal.provider.BaseClass
// persists automatically into calendar.registry.<id>.* prefs once the
// calendar id is set. The password is obfuscated with the SDR (the same
// store as Thunderbird's saved mail passwords) under an "sdr:" prefix;
// legacy "plain:" base64 values from the 0.1.x prefs decrypt on read.
//
// Globals injected by loader.js: Cc, Ci, Services(implicit via globals), DOMParser/TextDecoder/atob shims.

var SDR_CONTRACT = "@mozilla.org/login-manager/crypto/SDR;1";

function sdr() {
  return Cc[SDR_CONTRACT].getService(Ci.nsILoginManagerCrypto);
}

function encryptPassword(plain) {
  if (!plain) {
    return "";
  }
  try {
    return "sdr:" + sdr().encrypt(String(plain));
  } catch (e) {
    console.error("ews: password encrypt failed", e);
    return "";
  }
}

function decryptPassword(stored) {
  if (!stored) {
    return "";
  }
  stored = String(stored);
  try {
    if (stored.indexOf("sdr:") === 0) {
      return sdr().decrypt(stored.substring(4));
    }
    if (stored.indexOf("plain:") === 0) {
      // Legacy 0.1.x fallback: "plain:" + base64 of UTF-8 bytes.
      var bin = atob(stored.substring(6));
      return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    }
  } catch (e) {}
  return "";
}

function boolProp(v) {
  return v === true || v === "true";
}

function getProps(calObj) {
  function prop(name) {
    var v = calObj.getProperty(name);
    return v === null || v === undefined ? "" : v;
  }
  return {
    url: String(prop("url") || ""),
    email: String(prop("email") || ""),
    authMethod: String(prop("authMethod") || "auto"),
    password: decryptPassword(prop("password")),
    refreshInterval: parseInt(prop("refreshInterval"), 10) || 30,
    folderId: String(prop("folderId") || ""),
    readOnly: boolProp(prop("readOnly")),
    lastSyncOk: boolProp(prop("ews-lastSyncOk")),
    lastSyncError: String(prop("ews-lastSyncError") || ""),
    lastSyncTime: String(prop("ews-lastSyncTime") || ""),
    lastSyncCount: parseInt(prop("ews-lastSyncCount"), 10) || 0,
  };
}

function setProps(calObj, cfg) {
  cfg = cfg || {};
  if (cfg.url !== undefined) {
    calObj.setProperty("url", String(cfg.url || ""));
  }
  if (cfg.email !== undefined) {
    calObj.setProperty("email", String(cfg.email || ""));
  }
  if (cfg.authMethod !== undefined) {
    calObj.setProperty("authMethod", cfg.authMethod === "basic" ? "basic" : "auto");
  }
  if (cfg.refreshInterval !== undefined) {
    calObj.setProperty(
      "refreshInterval",
      Math.max(1, Math.min(1440, parseInt(cfg.refreshInterval, 10) || 30))
    );
  }
  if (cfg.folderId !== undefined) {
    calObj.setProperty("folderId", String(cfg.folderId || ""));
  }
  if (cfg.readOnly !== undefined) {
    calObj.setProperty("readOnly", !!cfg.readOnly);
  }
  if (cfg.password !== undefined) {
    calObj.setProperty("password", cfg.password ? encryptPassword(cfg.password) : "");
  }
  if (cfg.displayName !== undefined) {
    try {
      calObj.name = String(cfg.displayName || calObj.name || "Exchange");
    } catch (e) {}
  }
}

function setSyncStatus(calObj, ok, error, count) {
  calObj.setProperty("ews-lastSyncOk", !!ok);
  calObj.setProperty("ews-lastSyncError", ok ? "" : String(error || "unknown error"));
  if (ok) {
    calObj.setProperty("ews-lastSyncTime", new Date().toISOString());
    calObj.setProperty("ews-lastSyncCount", parseInt(count, 10) || 0);
  }
}

module.exports = {
  encryptPassword: encryptPassword,
  decryptPassword: decryptPassword,
  getProps: getProps,
  setProps: setProps,
  setSyncStatus: setSyncStatus,
};
