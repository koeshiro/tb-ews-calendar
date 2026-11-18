// ews-transport.js — POST an EWS SOAP envelope over HTTPS.
// authMethod:
//   "auto" (default): NTLM handshake with email/password (works with
//     Exchange servers that reject Basic); on final 401 retries once without
//     any header so necko can run Negotiate/NTLM with the Windows session.
//   "ntlm": NTLM handshake only.
//   "basic": Authorization header from email/password.
// post() never rejects: { httpCode, doc, text, error, authChallenge }.
//
// Thunderbird-only (XMLHttpRequest from Cu.importGlobalProperties).
// `require` is provided by the experiment loader; tests exercise ews-ntlm
// and ews-client directly, not this file.

var EXPORTED_SYMBOLS = ["post"];

var _ntlm = require("./ews-ntlm.js");

function parseXml(text) {
  try {
    var doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.documentElement && doc.documentElement.nodeName === "parsererror") {
      return null;
    }
    return doc;
  } catch (e) {
    return null;
  }
}

function basicAuth(email, password) {
  var bytes = new TextEncoder().encode((email || "") + ":" + (password || ""));
  var bin = "";
  for (var i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return "Basic " + btoa(bin);
}

function postOnce(url, bodyXml, authHeader) {
  return new Promise(function (resolve) {
    // XMLHttpRequest is a real chrome constructor (added to the sandbox via
    // Cu.importGlobalProperties in the experiment loader).
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    try {
      xhr.responseType = "text";
    } catch (e) {}
    xhr.setRequestHeader("Content-Type", "text/xml; charset=utf-8");
    if (authHeader) {
      xhr.setRequestHeader("Authorization", authHeader);
    }
    try {
      xhr.timeout = 30000;
    } catch (e) {}

    var done = false;
    function fin(code, text, error) {
      if (done) {
        return;
      }
      done = true;
      var auth = null;
      try {
        auth = xhr.getResponseHeader("WWW-Authenticate");
      } catch (e) {}
      resolve({
        httpCode: code,
        doc: text ? parseXml(text) : null,
        text: text,
        authChallenge: auth,
        error: error,
      });
    }

    xhr.addEventListener("load", function () {
      var text = typeof xhr.response === "string" ? xhr.response : xhr.responseText || "";
      fin(xhr.status, text, null);
    });
    xhr.addEventListener("error", function () {
      fin(0, "", "network error");
    });
    xhr.addEventListener("timeout", function () {
      fin(0, "", "request timeout");
    });
    xhr.addEventListener("abort", function () {
      fin(0, "", "aborted");
    });

    try {
      xhr.send(bodyXml);
    } catch (e) {
      fin(0, "", String(e));
    }
  });
}

function ok(r) {
  return r.httpCode >= 200 && r.httpCode < 300;
}

function finishAuth(r, label) {
  if (r.httpCode === 401 && !r.error) {
    r.error = (label || "auth") + " rejected by server (HTTP 401)";
  }
  return r;
}

// Pick the "NTLM <base64>" token out of a WWW-Authenticate header value.
// Robust against any separator (commas, newlines) between schemes.
function extractNtlmToken(headerValue) {
  if (!headerValue) {
    return null;
  }
  var m = /NTLM\s+([^\s,]+)/i.exec(String(headerValue));
  return m ? m[1] : null;
}

// 3-message NTLM handshake: type1 -> 401+type2 -> type3.
function postNtlm(url, bodyXml, config) {
  var identity = _ntlm.parseIdentity(config.email);
  var type1 = _ntlm.buildType1Message();
  return postOnce(url, bodyXml, "NTLM " + type1).then(function (r1) {
    r1.authPath = "ntlm-handshake";
    if (r1.httpCode !== 401) {
      return r1;
    }
    var token = extractNtlmToken(r1.authChallenge);
    if (!token) {
      r1.error = "NTLM: server did not return a challenge (WWW-Authenticate: " +
        (r1.authChallenge || "none") + ")";
      return r1;
    }
    var type3;
    try {
      type3 = _ntlm.buildType3Message({
        user: identity.user,
        domain: identity.domain,
        password: config.password,
        type2: token,
      });
    } catch (e) {
      r1.error = "NTLM: " + (e.message || String(e));
      return r1;
    }
    return postOnce(url, bodyXml, "NTLM " + type3).then(function (r) {
      r.authPath = "ntlm-handshake";
      return finishAuth(r, "NTLM (saved credentials)");
    });
  });
}

function post(bodyXml, config) {
  config = config || {};
  var url = config.url;
  if (!url) {
    return Promise.resolve({ httpCode: 0, doc: null, text: "", error: "no url configured" });
  }
  var method = config.authMethod || "auto";

  if (method === "basic") {
    var auth = config.email && config.password ? basicAuth(config.email, config.password) : null;
    return postOnce(url, bodyXml, auth).then(function (r) {
      r.authPath = "basic";
      return finishAuth(r, auth ? "Basic (saved credentials)" : "unauthenticated request (no password)");
    });
  }

  if (method === "ntlm") {
    if (!config.email || !config.password) {
      return Promise.resolve({
        httpCode: 0,
        doc: null,
        text: "",
        error: "NTLM requires email and password",
      });
    }
    return postNtlm(url, bodyXml, config);
  }

  // "auto": NTLM with saved credentials; on 401 one plain retry so necko can
  // try the logged-in Windows session (Negotiate/NTLM SSO).
  if (config.email && config.password) {
    return postNtlm(url, bodyXml, config).then(function (r) {
      if (r.httpCode === 401) {
        return postOnce(url, bodyXml, null).then(function (r2) {
          r2.authPath = "plain-fallback";
          return finishAuth(r2, "plain request (SSO, no credentials sent)");
        });
      }
      return r;
    });
  }
  return postOnce(url, bodyXml, null).then(function (r) {
    r.authPath = "plain-no-password";
    return finishAuth(r, "unauthenticated request (no password configured)");
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { post: post };
}
