// test/ews.test.mjs — end-to-end check of the EWS layer against a real server.
// Reads EWS_URL/EWS_EMAIL/EWS_PASSWORD from test/.env (or the file pointed to
// by the ENV_PATH env var) and uses curl --negotiate transport.
// Read-only by default; pass `--write` to also exercise Create/Update/Delete.
//
//   node test/ews.test.mjs [--write]

import { createRequire } from "module";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseXml } from "./xmldom.mjs";

const require = createRequire(import.meta.url);
const client = require("../lib/ews-client.js");
const dt = require("../lib/ews-datetime.js");

const ENV_PATH = process.env.ENV_PATH || fileURLToPath(new URL("./.env", import.meta.url));
const DO_WRITE = process.argv.includes("--write");

function loadEnv(p) {
  const out = {};
  if (!fs.existsSync(p)) {
    return out;
  }
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) {
      continue;
    }
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(ENV_PATH);
const EMAIL = env.EWS_EMAIL;
const PASSWORD = env.EWS_PASSWORD;
const URL = env.EWS_URL || "https://owa.example.com/ews/exchange.asmx";
if (!EMAIL || !PASSWORD) {
  console.error("No EWS_EMAIL/EWS_PASSWORD in " + ENV_PATH);
  process.exit(2);
}

function postSoap(xmlBody) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ews-"));
  const cfg = path.join(tmp, "curl.cfg");
  const user = EMAIL + ":" + PASSWORD;
  const cfgValue = user.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  fs.writeFileSync(cfg, 'user = "' + cfgValue + '"\n', "utf8");
  const inFile = path.join(tmp, "in.xml");
  fs.writeFileSync(inFile, xmlBody, "utf8");
  const outFile = path.join(tmp, "out.xml");
  const res = spawnSync(
    "curl",
    [
      "-sS", "--negotiate", "--max-time", "30",
      "--config", cfg,
      "-H", "Content-Type: text/xml; charset=utf-8",
      "-o", outFile,
      "-w", "%{http_code}",
      "--data-binary", "@" + inFile,
      URL,
    ],
    { encoding: "utf8" }
  );
  let code = 0;
  let body = "";
  try {
    code = parseInt((res.stdout || "").trim(), 10) || 0;
    body = fs.readFileSync(outFile, "utf8");
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* ignore */
    }
  }
  if (res.status !== 0) {
    throw new Error("curl exit " + res.status + ": " + (res.stderr || "").trim());
  }
  return { code, body };
}

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function check(label, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  — " + detail : ""));
  return ok;
}

function faultOf(body) {
  const doc = parseXml(body);
  const st = client.responseStatus ? null : null;
  // use ews-xml responseStatus via client is not exported; re-derive
  const doc2 = doc;
  void doc2;
  return body;
}

let allOk = true;

// --- 1. FindFolder ----------------------------------------------------------
{
  const req = client.buildFindFolder();
  const { code, body } = postSoap(req);
  const doc = parseXml(body);
  const res = client.parseFindFolder(doc);
  allOk &= check("FindFolder HTTP " + code, code === 200 && res.status.ok,
    "serverId=" + res.serverId + " name=" + res.displayName + " count=" + res.totalCount +
    (res.status.ok ? "" : " err=" + res.status.code + " " + res.status.message));
}

// --- 2. FindItem (CalendarView, last 30 days) -------------------------------
let sampleItem = null;
{
  const now = Date.now();
  const start = iso(now - 30 * 86400000);
  const end = iso(now + 3600000);
  const req = client.buildFindItemCalendarView(start, end, null, 100);
  const { code, body } = postSoap(req);
  const doc = parseXml(body);
  const res = client.parseFindItem(doc);
  allOk &= check(
    "FindItem HTTP " + code + " items=" + res.items.length,
    code === 200 && res.status.ok && res.items.length >= 0,
    res.status.ok ? "" : "err=" + res.status.code + " " + res.status.message
  );
  if (res.items.length) {
    sampleItem = res.items[0];
    const a = sampleItem;
    console.log(
      "      sample: [" + a.startISO + "] " + (a.subject || "(no subject)") +
      "  allDay=" + a.isAllDay + " org=" + a.organizer +
      " type=" + (a.meetingRequestType || "-") + " attendees=" + a.attendees.length
    );
    if (a.attendees.length) {
      console.log("      attendee[0]: " + a.attendees[0].name + " <" + a.attendees[0].email +
        "> type=" + a.attendees[0].type + " resp=" + a.attendees[0].response);
    }
  } else {
    console.log("      (no items in window; showing raw head)");
    console.log("      " + body.slice(0, 600).replace(/\s+/g, " "));
  }
}

// --- 3. SyncCalendarItems ----------------------------------------------------
{
  const req = client.buildSyncCalendarItems(null, null, 100);
  const { code, body } = postSoap(req);
  const doc = parseXml(body);
  const res = client.parseSync(doc);
  allOk &= check(
    "SyncCalendarItems HTTP " + code + " items=" + res.items.length +
      " deleted=" + res.deleted.length,
    code === 200 && res.status.ok,
    "syncState=" + (res.syncState ? res.syncState.length + " chars" : "none") +
    (res.status.ok ? "" : " err=" + res.status.code + " " + res.status.message)
  );
}

// --- 4. ResolveNames (optional, informational) ------------------------------
{
  const req = client.buildResolveNames(EMAIL);
  const { code, body } = postSoap(req);
  const doc = parseXml(body);
  const res = client.parseResolveNames(doc);
  allOk &= check(
    "ResolveNames HTTP " + code + " results=" + res.results.length,
    code === 200 && res.status.ok,
    res.results[0] ? res.results[0].displayName + " <" + res.results[0].email + ">" :
      (res.status.ok ? "no results" : res.status.code + " " + res.status.message)
  );
}

// --- 5. Write path (opt-in) --------------------------------------------------
if (DO_WRITE) {
  let createdId = null;
  let createdKey = null;
  {
    const start = iso(Date.now() + 2 * 86400000);
    const end = iso(Date.now() + 2 * 86400000 + 3600000);
    const item = { subject: "tb-ews self-test (safe to delete)", startISO: start, endISO: end, isAllDay: false, attendees: [] };
    const req = client.buildCreateItem(item, { isMeeting: false, tz: null });
    const { code, body } = postSoap(req);
    const res = client.parseCreateItem(parseXml(body));
    createdId = res.id;
    createdKey = res.changeKey;
    allOk &= check("CreateItem HTTP " + code, code === 200 && res.status.ok && !!res.id,
      "id=" + res.id + (res.status.ok ? "" : " " + res.status.code + " " + res.status.message));
  }
  if (createdId) {
    // Update subject
    const updReq = client.buildUpdateItem(createdId, createdKey, [
      { op: "replace", field: "Subject", valueXml: "<t:Subject>tb-ews self-test (updated)</t:Subject>" },
    ]);
    const u = postSoap(updReq);
    const ures = client.parseCreateItem(parseXml(u.body)); // reuse status parse
    allOk &= check("UpdateItem HTTP " + u.code, u.code === 200 && ures.status.ok,
      ures.status.ok ? "" : ures.status.code + " " + ures.status.message);
    // Delete
    const delReq = client.buildDeleteItem(createdId, createdKey, { isMeeting: false });
    const d = postSoap(delReq);
    const dres = client.parseCreateItem(parseXml(d.body));
    allOk &= check("DeleteItem HTTP " + d.code, d.code === 200 && dres.status.ok,
      dres.status.ok ? "" : dres.status.code + " " + dres.status.message);
  }
} else {
  console.log("INFO  write path skipped (pass --write to test Create/Update/Delete)");
}

console.log(allOk ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allOk ? 0 : 1);
