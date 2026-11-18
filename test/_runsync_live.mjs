// test/_runsync_live.mjs — run the REAL runSync (FindItem window sync) from
// lib against the real server. Prints result summary.
import { readFileSync } from "node:fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ntlm = require("../lib/ews-ntlm.js");
const sync = require("../lib/ews-sync.js");
const https = require("node:https");

// Node shims for the sandbox globals the lib code expects.
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
{
  const { parseXml } = await import("./xmldom.mjs");
  globalThis.DOMParser = function () {
    this.parseFromString = (t) => parseXml(t);
  };
}
globalThis.XMLHttpRequest = class {
  constructor() {
    this._ev = {};
    this._h = {};
  }
  open(m, u) {
    this._u = new URL(u);
  }
  setRequestHeader(k, v) {
    this._h[k] = v;
  }
  addEventListener(ev, fn) {
    (this._ev[ev] ||= []).push(fn);
  }
  getResponseHeader(name) {
    return (this._rh && this._rh[name.toLowerCase()]) || null;
  }
  send(body) {
    const data = Buffer.from(String(body), "utf8");
    const self = this;
    const req = https.request(
      {
        hostname: self._u.hostname,
        port: self._u.port || 443,
        path: self._u.pathname + (self._u.search || ""),
        method: "POST",
        headers: { ...self._h, "Content-Length": data.length },
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          self.status = res.statusCode;
          self._rh = res.headers;
          self.response = self.responseText = Buffer.concat(chunks).toString("utf8");
          (self._ev.load || []).forEach((fn) => fn());
        });
      }
    );
    req.on("error", () => (self._ev.error || []).forEach((fn) => fn()));
    req.on("timeout", () => (self._ev.timeout || []).forEach((fn) => fn()));
    req.write(data);
    req.end();
  }
};

const env = {};
const envPath = process.env.ENV_PATH || new URL("./.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = new URL(env.EWS_URL);

function post(bodyStr, authHeader) {
  const body = Buffer.from(bodyStr, "utf8");
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": body.length,
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, wwwAuth: res.headers["www-authenticate"] || null, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(body);
    req.end();
  });
}

async function postEws(bodyStr) {
  const identity = ntlm.parseIdentity(env.EWS_EMAIL);
  const r1 = await post(bodyStr, "NTLM " + ntlm.buildType1Message());
  if (r1.status !== 401) return r1;
  const tk = (r1.wwwAuth || "").match(/NTLM\s+([^\s,]+)/i)?.[1];
  const t3 = ntlm.buildType3Message({
    user: identity.user,
    domain: identity.domain,
    password: env.EWS_PASSWORD,
    type2: tk,
  });
  return post(bodyStr, "NTLM " + t3);
}

const t0 = Date.now();
const r = await sync.runSync(
  { url: env.EWS_URL, email: env.EWS_EMAIL, password: env.EWS_PASSWORD, authMethod: "auto" },
  { onProgress: (msg) => console.log("progress:", msg) }
);
console.log("runSync: ok =", r.ok, "| HTTP", r.httpCode, "| items =", r.items.length, "|", Date.now() - t0 + "ms");
if (!r.ok) {
  console.log("error:", r.error);
} else {
  const withSubj = r.items.filter((it) => it.subject).length;
  const recurring = r.items.filter((it) => /^(Recurrence|Occurrence)$/.test(it.meetingRequestType || "")).length;
  console.log("items with subject:", withSubj);
  const sample = r.items.slice(0, 3).map((it) => ({
    subject: (it.subject || "").slice(0, 40),
    start: it.startISO,
    allDay: it.isAllDay,
    organizer: it.organizer ? it.organizer.slice(0, 30) : null,
  }));
  console.log(JSON.stringify(sample, null, 1));
  const ids = new Set(r.items.map((it) => it.id));
  console.log("unique ids:", ids.size, "/", r.items.length);
  console.log("window:", r.windowStartISO, "→", r.windowEndISO);
}
