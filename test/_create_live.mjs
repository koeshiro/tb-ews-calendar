// test/_create_live.mjs — reproduce a real CreateItem against the server and
// print the RAW response so server-side rejects are diagnosable. Creates a
// test event and (on success) deletes it again via SoftDelete.
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
globalThis.XMLHttpRequest = class {}; // not used here; direct https below

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

// A test event ~3 days ahead, 10:00–11:00 UTC.
const start = new Date(Date.now() + 3 * 86400000);
start.setUTCHours(10, 0, 0, 0);
const end = new Date(start.getTime() + 3600000);
const item = {
  subject: "ews-addon test event (safe to delete)",
  bodyText: "created by test/_create_live.mjs",
  startISO: start.toISOString(),
  endISO: end.toISOString(),
  isAllDay: false,
  location: "",
  organizer: null,
  attendees: [],
};

const body = client.buildCreateItem(item, { isMeeting: false, sendInvites: false, tz: null });
console.log("--- REQUEST ---");
console.log(body);
const r = await postEws(body);
console.log("--- HTTP", r.status, "---");
const doc = new DOMParser().parseFromString(r.text);
const parsed = client.parseCreateItem(doc);
console.log("--- PARSED ---");
console.log(JSON.stringify(parsed, null, 1));
console.log("--- RAW (first 1500) ---");
console.log(r.text.slice(0, 1500));

if (parsed.status.ok && parsed.id) {
  console.log("CREATE OK — deleting test item again...");
  const del = client.buildDeleteItem(parsed.id, parsed.changeKey, { isMeeting: false });
  const rd = await postEws(del);
  const xml = require("../lib/ews-xml.js");
  const st = xml.responseStatus(new DOMParser().parseFromString(rd.text));
  console.log("DELETE HTTP", rd.status, "ok =", st.ok, "code =", st.code, st.message);
}
