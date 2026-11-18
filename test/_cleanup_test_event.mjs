// test/_cleanup_test_event.mjs — find and delete leftover "ews-addon test"
// events from the live-test runs (they were created around the same slot).
import { readFileSync } from "node:fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ntlm = require("../lib/ews-ntlm.js");
const client = require("../lib/ews-client.js");
const https = require("node:https");

globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
{
  const { parseXml } = await import("./xmldom.mjs");
  globalThis.DOMParser = function () {
    this.parseFromString = (t) => parseXml(t);
  };
}

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
          resolve({
            status: res.statusCode,
            wwwAuth: res.headers["www-authenticate"] || null,
            text: Buffer.concat(chunks).toString("utf8"),
          })
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

const start = new Date(Date.now() - 1 * 86400000);
start.setUTCHours(0, 0, 0, 0);
const end = new Date(Date.now() + 6 * 86400000);
end.setUTCHours(0, 0, 0, 0);
const iso = (d) => d.toISOString();

const body = client.buildFindItemCalendarView(iso(start), iso(end), null, 1000);
const r = await postEws(body);
const doc = new DOMParser().parseFromString(r.text);
const parsed = client.parseFindItem(doc);
const tests = parsed.items.filter((it) => /ews-addon test/i.test(it.subject || ""));
console.log("HTTP", r.status, "| items in window:", parsed.items.length, "| test events:", tests.length);
for (const t of tests) {
  console.log("deleting:", t.subject, "| start", t.startISO, "| changeKey:", (t.changeKey || "").slice(0, 20) + "...");
  const del = client.buildDeleteItem(t.id, t.changeKey, { isMeeting: false });
  const rd = await postEws(del);
  const st = require("../lib/ews-xml.js").responseStatus(new DOMParser().parseFromString(rd.text));
  console.log("  -> HTTP", rd.status, "ok =", st.ok, "code =", st.code, st.message);
}
if (!tests.length) console.log("no leftover test events — the +1 item is not mine");
