// test/ews.parser.test.mjs — offline validation of the EWS layer.
// No network: asserts the request XML is well-formed (and matches the real
// EWS wire format) and that realistic EWS response fixtures parse into the
// normalized item shape. Run with:
//   node test/ews.parser.test.mjs

import { createRequire } from "module";
import { parseXml } from "./xmldom.mjs";

const require = createRequire(import.meta.url);
const client = require("../lib/ews-client.js");
const xml = require("../lib/ews-xml.js");
const dt = require("../lib/ews-datetime.js");
const ntlm = require("../lib/ews-ntlm.js");

let allOk = true;
function check(label, ok, detail) {
  allOk = allOk && ok;
  console.log((ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  — " + detail : ""));
}
function reqHas(label, req, needles) {
  const missing = needles.filter((n) => req.indexOf(n) < 0);
  check(label, missing.length === 0, missing.length ? "missing: " + missing.join(", ") : "");
}

const T = "http://schemas.microsoft.com/exchange/services/2006/types";
const M = "http://schemas.microsoft.com/exchange/services/2006/messages";
const env = (body) =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="${T}" xmlns:m="${M}">` +
  `<soap:Body>${body}</soap:Body></soap:Envelope>`;

// --- 1. Request builders are well-formed ------------------------------------
{
  const ff = client.buildFindFolder();
  reqHas("buildFindFolder", ff, [
    "<m:FindFolder",
    'Traversal="Shallow"',
    "<t:BaseShape>Default</t:BaseShape>",
    '<t:DistinguishedFolderId Id="calendar"/>',
    "<m:ParentFolderIds>",
    "soap:Envelope",
  ]);
  check("buildFindFolder parses, op present",
    !!xml.findDesc(parseXml(ff), "m:FindFolder"));

  const fi = client.buildFindItemCalendarView("2026-11-01T00:00:00.000Z", "2026-11-30T23:59:59.000Z", null, 100);
  reqHas("buildFindItemCalendarView", fi,
    ["<m:FindItem", "CalendarView", 'StartDate="2026-11-01T00:00:00.000Z"',
     'EndDate="2026-11-30T23:59:59.000Z"', 'MaxEntriesReturned="100"', "<m:ParentFolderIds>"]);
  check("FindItem uses BaseShape Default (All rejected by some gateways)",
    fi.indexOf("<t:BaseShape>Default</t:BaseShape>") >= 0);

  const sc = client.buildSyncFolderItems("BASE64", null, 512, null, null);
  reqHas("buildSyncFolderItems", sc, [
    "<m:SyncFolderItems",
    "<m:SyncFolderId>",
    '<t:DistinguishedFolderId Id="calendar"/>',
    "<m:MaxEntriesReturned>512</m:MaxEntriesReturned>",
    "<m:SyncState>BASE64</m:SyncState>",
  ]);

  const ci = client.buildCreateItem(
    { subject: "Тест", startISO: "2026-12-01T09:00:00.000Z", endISO: "2026-12-01T10:00:00.000Z", isAllDay: false,
      attendees: [{ email: "a@example.com", name: "A", type: "Required" }, { email: "b@example.com", type: "Optional" }] },
    { isMeeting: true, sendInvites: true, tz: null }
  );
  reqHas("buildCreateItem(meeting)", ci,
    ["<m:CreateItem", 'SendMeetingInvitations="SendToAllAndSaveCopy"', "RequiredAttendees", "OptionalAttendees",
     "<t:Mailbox><t:EmailAddress>a@example.com</t:EmailAddress><t:Name>A</t:Name></t:Mailbox>"]);

  const up = client.buildUpdateItem("ID123", "CK456", [
    { field: "Subject", valueXml: "<t:Subject>Новое</t:Subject>" },
    { field: "Location", valueXml: "<t:Location>Зал 1</t:Location>" },
  ], { isMeeting: true, sendInvites: true });
  reqHas("buildUpdateItem", up, [
    "<m:UpdateItem", 'ConflictResolution="AlwaysOverwrite"',
    "<t:ItemChange>", '<t:ItemId Id="ID123" ChangeKey="CK456"/>',
    "<t:Updates>",
    '<t:FieldURI FieldURI="calendar:Subject"/>',
    "<t:CalendarItem><t:Subject>Новое</t:Subject></t:CalendarItem>",
    '<t:FieldURI FieldURI="calendar:Location"/>',
    "</t:Updates></t:ItemChange></m:ItemChanges>",
  ]);

  const del = client.buildDeleteItem("ID123", "CK", { isMeeting: true, sendInvites: true });
  reqHas("buildDeleteItem", del,
    ["<m:DeleteItem", 'DeleteType="SoftDelete"', 'SendMeetingCancellations="SendToAllAndSaveCopy"',
     "<m:ItemIds>", '<t:ItemId Id="ID123" ChangeKey="CK"/>']);

  const rm = client.buildRespondMeeting("ID123", "CK", "me@example.com", "Tentative");
  reqHas("buildRespondMeeting(Tentative)", rm, [
    "<m:CreateItem", 'SendMeetingInvitations="SendToAllAndSaveCopy"',
    "<t:TentativelyAcceptItem>",
    '<t:ReferenceItemId Id="ID123" ChangeKey="CK"/>',
    "<t:EmailAddress>me@example.com</t:EmailAddress>",
  ]);
  check("buildRespondMeeting(Accept) uses AcceptItem",
    client.buildRespondMeeting("I", "C", "m@x.ru", "Accept").indexOf("<t:AcceptItem>") >= 0);
  check("buildRespondMeeting(Decline) uses DeclineItem",
    client.buildRespondMeeting("I", "C", "m@x.ru", "Decline").indexOf("<t:DeclineItem>") >= 0);
}

// --- 2. FindFolder parse ----------------------------------------------------
{
  const body = `<m:FindFolderResponse><m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success">` +
    `<m:RootFolders><t:CalendarFolder><t:FolderId Id="AAMkAGFudAA=" ChangeKey="AQAAAA=="/>` +
    `<t:DisplayName>Календарь</t:DisplayName><t:TotalCount>42</t:TotalCount></t:CalendarFolder></m:RootFolders>` +
    `</m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse>`;
  const res = client.parseFindFolder(parseXml(env(body)));
  check("FindFolder parse ok", res.status.ok && res.status.code === "NoError", res.status.code);
  check("FindFolder serverId", res.serverId === "AAMkAGFudAA=", "id=" + res.serverId);
  check("FindFolder name+count", res.displayName === "Календарь" && res.totalCount === 42,
    res.displayName + " " + res.totalCount);
}

// --- 3. FindItem (CalendarView) parse ---------------------------------------
// Some gateways wrap items in m:RootFolder/t:Items (not m:RootItems).
{
  const body =
    `<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success">` +
    `<m:RootFolder TotalItemsInView="134" IncludesLastItemInRange="true"><t:Items><t:CalendarItem>` +
    `<t:ItemId Id="AAMkAGFudAA=" ChangeKey="AQAAAAA=="/>` +
    `<t:Subject>Синк-тест</t:Subject>` +
    `<t:Body BodyType="HTML"><![CDATA[<div>Привет &amp; мир</div>]]></t:Body>` +
    `<t:Start>2026-11-20T09:00:00.000Z</t:Start><t:End>2026-11-20T10:00:00.000Z</t:End>` +
    `<t:IsAllDayEvent>false</t:IsAllDayEvent><t:Location>Зал 5</t:Location>` +
    `<t:Organizer><t:DisplayName>Sergey Orlov</t:DisplayName><t:Address>SMTP:sergey.orlov@example.com</t:Address></t:Organizer>` +
    `<t:MeetingRequestType>NewMeetingRequest</t:MeetingRequestType><t:IsOnlineMeeting>true</t:IsOnlineMeeting>` +
    `<t:Attendees>` +
    `<t:Attendee><t:Mailbox><t:Name>ivan.petrov@example.com</t:Name>` +
    `<t:EmailAddress>SMTP:ivan.petrov@example.com</t:EmailAddress></t:Mailbox>` +
    `<t:AttendeeType>Required</t:AttendeeType><t:ResponseType>Accept</t:ResponseType></t:Attendee>` +
    `<t:Attendee><t:Mailbox><t:Name>anna.sidorova@example.com</t:Name>` +
    `<t:EmailAddress>SMTP:anna.sidorova@example.com</t:EmailAddress></t:Mailbox>` +
    `<t:AttendeeType>Optional</t:AttendeeType><t:ResponseType>NoResponseReceived</t:ResponseType></t:Attendee>` +
    `</t:Attendees></t:CalendarItem></t:Items></m:RootFolder>` +
    `</m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>`;
  const res = client.parseFindItem(parseXml(env(body)));
  check("FindItem parse ok, 1 item", res.status.ok && res.items.length === 1, res.status.code);
  const it = res.items[0] || {};
  check("Item id/key/subject", it.id === "AAMkAGFudAA=" && it.changeKey === "AQAAAAA==" && it.subject === "Синк-тест",
    (it.id || "-") + " " + (it.subject || "-"));
  check("Item times+allDay", it.startISO === "2026-11-20T09:00:00.000Z" && it.endISO === "2026-11-20T10:00:00.000Z" && it.isAllDay === false,
    (it.startISO || "-"));
  check("Item location/online", it.location === "Зал 5" && it.isOnlineMeeting === true, (it.location || "-"));
  check("Item organizer cleaned", it.organizer === "sergey.orlov@example.com" && it.organizerName === "Sergey Orlov",
    it.organizer + " / " + it.organizerName);
  check("Item meetingRequestType", it.meetingRequestType === "NewMeetingRequest", it.meetingRequestType);
  check("Item attendees=2, cleaned email + ResponseType",
    it.attendees.length === 2 &&
    it.attendees[0].email === "ivan.petrov@example.com" && it.attendees[0].response === "Accept" &&
    it.attendees[1].type === "Optional" && it.attendees[1].response === "NoResponseReceived",
    (it.attendees[0] || {}).email + "/" + (it.attendees[0] || {}).response);
  check("Item bodyText from HTML", typeof it.bodyText === "string" && it.bodyText.indexOf("Привет") >= 0, it.bodyText);
}

// --- 4. SyncFolderItems parse -----------------------------------------------
{
  const body =
    `<m:SyncFolderItemsResponse><m:ResponseMessages>` +
    `<m:SyncFolderItemsResponseMessage ResponseClass="Success">` +
    `<m:Changes>` +
    `<t:Delete><t:ItemId Id="DEAD1" ChangeKey="X"/></t:Delete>` +
    `<t:Update><t:CalendarItem><t:ItemId Id="UPD9" ChangeKey="Y"/><t:Subject>Обновлён</t:Subject>` +
    `<t:Start>2026-11-21T09:00:00.000Z</t:Start><t:End>2026-11-21T10:00:00.000Z</t:End>` +
    `<t:Attendees><t:Attendee><t:Mailbox><t:EmailAddress>org@example.com</t:EmailAddress></t:Mailbox>` +
    `<t:AttendeeType>Required</t:AttendeeType></t:Attendee></t:Attendees></t:CalendarItem></t:Update>` +
    `<t:Create><t:CalendarItem><t:ItemId Id="NEW7" ChangeKey="Z"/><t:Subject>Новый</t:Subject>` +
    `<t:Start>2026-11-22T09:00:00.000Z</t:Start><t:End>2026-11-22T10:00:00.000Z</t:End></t:CalendarItem></t:Create>` +
    `</m:Changes>` +
    `<m:SyncState>BASE64SYNCSTATE</m:SyncState>` +
    `<m:IncludesLastItemInRange>true</m:IncludesLastItemInRange>` +
    `</m:SyncFolderItemsResponseMessage></m:ResponseMessages></m:SyncFolderItemsResponse>`;
  const res = client.parseSync(parseXml(env(body)));
  check("Sync parse ok", res.status.ok, res.status.code);
  check("Sync syncState", res.syncState === "BASE64SYNCSTATE", (res.syncState || "-").slice(0, 20));
  check("Sync includesLast", res.includesLast === true, String(res.includesLast));
  check("Sync deleted=[DEAD1]", res.deleted.length === 1 && res.deleted[0] === "DEAD1", res.deleted.join(","));
  check("Sync updated item", res.updated.length === 1 && res.updated[0].id === "UPD9" && res.updated[0].subject === "Обновлён",
    (res.updated[0] || {}).subject);
  check("Sync created item", res.created.length === 1 && res.created[0].id === "NEW7" && res.created[0].subject === "Новый",
    (res.created[0] || {}).subject);
  check("Sync attendee mailbox parsed", (res.updated[0].attendees[0] || {}).email === "org@example.com",
    (res.updated[0].attendees[0] || {}).email);
}

// --- 5. ResolveNames parse --------------------------------------------------
{
  const body =
    `<m:ResolveNamesResponse><m:ResponseMessages><m:ResolveNamesResponseMessage ResponseClass="Success">` +
    `<m:ResolutionSet Indexed="true"><t:Resolution>` +
    `<t:ItemId Id="AAMkAGVudAA="/><t:Mailbox><t:EmailAddress>SMTP:ivan.petrov@example.com</t:EmailAddress>` +
    `<t:Name>Петров Иван</t:Name></t:Mailbox>` +
    `<t:Contact><t:DisplayName>Петров Иван Петрович</t:DisplayName></t:Contact>` +
    `</t:Resolution></m:ResolutionSet>` +
    `</m:ResolveNamesResponseMessage></m:ResponseMessages></m:ResolveNamesResponse>`;
  const res = client.parseResolveNames(parseXml(env(body)));
  check("ResolveNames parse ok, 1", res.status.ok && res.results.length === 1, res.status.code);
  const r = res.results[0] || {};
  check("ResolveNames cleaned email + display + id",
    r.email === "ivan.petrov@example.com" && r.displayName === "Петров Иван Петрович" && r.id === "AAMkAGVudAA=",
    (r.email || "-") + " " + (r.displayName || "-"));
}

// --- 6. Fault handling ------------------------------------------------------
{
  const body = `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>InvalidItemShape</faultstring></soap:Fault>`;
  const res = client.parseFindItem(parseXml(env(body)));
  check("Fault detected as !ok", res.status.ok === false && res.status.fault === true,
    (res.status.code || "") + " " + (res.status.message || ""));
  // Real gateway error shape (ResponseCode/MessageText are ELEMENTS; the
  // envelope may use s: prefix). Regression: this used to surface as
  // "UnknownError" with the real reason lost.
  const errBody =
    `<m:CreateItemResponse><m:ResponseMessages>` +
    `<m:CreateItemResponseMessage ResponseClass="Error">` +
    `<m:MessageText>The SendMeetingInvitations attribute is required for calendar items.</m:MessageText>` +
    `<m:ResponseCode>ErrorSendMeetingInvitationsRequired</m:ResponseCode>` +
    `<m:DescriptiveLinkKey>0</m:DescriptiveLinkKey><m:Items/></m:CreateItemResponseMessage>` +
    `</m:ResponseMessages></m:CreateItemResponse>`;
  const st = xml.responseStatus(parseXml(env(errBody)));
  check("responseStatus reads element error code+message",
    st.ok === false &&
      st.code === "ErrorSendMeetingInvitationsRequired" &&
      st.message.indexOf("SendMeetingInvitations attribute is required") >= 0,
    st.code + " " + st.message);
}

// --- 7. Small pure helpers --------------------------------------------------
{
  check("cleanSmtp", client.cleanSmtp("SMTP:ivan@x.ru") === "ivan@x.ru" && client.cleanSmtp("plain@x.ru") === "plain@x.ru",
    client.cleanSmtp("SMTP:ivan@x.ru"));
  const pt = dt.isoToPRTime("2026-11-20T09:00:00.000Z");
  check("isoToPRTime roundtrip", dt.prTimeToISO(pt) === "2026-11-20T09:00:00.000Z", dt.prTimeToISO(pt));
  check("isoToIcal utc datetime", dt.isoToIcal("2026-09-22T09:00:00Z") === "20260922T090000Z",
    dt.isoToIcal("2026-09-22T09:00:00Z"));
  check("isoToIcal millis utc", dt.isoToIcal("2026-09-22T09:00:00.000Z") === "20260922T090000Z",
    dt.isoToIcal("2026-09-22T09:00:00.000Z"));
  check("isoToIcal naive stays floating", dt.isoToIcal("2026-09-22T09:00:00") === "20260922T090000",
    dt.isoToIcal("2026-09-22T09:00:00"));
  check("isoToIcal date-only", dt.isoToIcal("2026-09-22T09:00:00Z", true) === "20260922",
    dt.isoToIcal("2026-09-22T09:00:00Z", true));
  check("isoToIcal garbage -> null", dt.isoToIcal("") === null && dt.isoToIcal("nonsense") === null,
    String(dt.isoToIcal("nonsense")));
  const tz = dt.tzInfo();
  check("tzInfo shape", Number.isInteger(tz.bias) && typeof tz.name === "string",
    "bias=" + tz.bias + " name=" + tz.name);
  check("timeZoneXml", dt.timeZoneXml().indexOf("<t:Bias>") >= 0, dt.timeZoneXml());
}

// --- 8. NTLM primitives (known vectors) --------------------------------------
{
  check("md4(empty)", ntlm.bytesToHex(ntlm.md4(new Uint8Array(0))) === "31d6cfe0d16ae931b73c59d7e0c089c0",
    ntlm.bytesToHex(ntlm.md4(new Uint8Array(0))));
  check("md4('a')", ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("a"))) === "bde52cb31de33e46245e05fbdbd6fb24",
    ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("a"))));
  check("md5(empty)", ntlm.bytesToHex(ntlm.md5(new Uint8Array(0))) === "d41d8cd98f00b204e9800998ecf8427e",
    ntlm.bytesToHex(ntlm.md5(new Uint8Array(0))));
  check("md5 50-byte (rfc1321 #6)",
    ntlm.bytesToHex(ntlm.md5(ntlm.utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ===
      "8215ef0796a20bcaaae116d3876c664a",
    ntlm.bytesToHex(ntlm.md5(ntlm.utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))));
  check("ntHash('Password')", ntlm.bytesToHex(ntlm.ntHash("Password")) === "a4f49c406510bdcab6824ee7c30fd852",
    ntlm.bytesToHex(ntlm.ntHash("Password")));
  check("hmac-md5 vector (verified via python hmac)",
    ntlm.bytesToHex(ntlm.hmacMd5(ntlm.utf8Bytes("key"), ntlm.utf8Bytes("The quick brown fox jumps over the lazy dog"))) ===
      "80070713463e7749b90c2dc24911e275",
    ntlm.bytesToHex(ntlm.hmacMd5(ntlm.utf8Bytes("key"), ntlm.utf8Bytes("The quick brown fox jumps over the lazy dog"))));
  check("md4 50-byte (certutil)",
    ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ===
      "4691a9ec81b1a6bd1ab8557240b245c5",
    ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))));
  check("md4 80-byte multi-block (certutil)",
    ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))) ===
      "e33b4ddc9c38f2199c3e7b164fcc0536",
    ntlm.bytesToHex(ntlm.md4(ntlm.utf8Bytes("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))));
  // Verified against OpenSSL (node --openssl-legacy-provider) md4+hmac chain.
  check("ntlmv2 hash chain (User/Domain/Password, OpenSSL-verified)",
    ntlm.bytesToHex(ntlm.hmacMd5(ntlm.ntHash("Password"), ntlm.utf16le("USER" + "DOMAIN"))) ===
      "f38efea48ada6afaa95ae44669e5634b",
    ntlm.bytesToHex(ntlm.hmacMd5(ntlm.ntHash("Password"), ntlm.utf16le("USER" + "DOMAIN"))));

  // Type1: valid signature, type 1, flags present.
  const t1 = Buffer.from(ntlm.buildType1Message(), "base64");
  check("type1 signature", t1.subarray(0, 8).toString("latin1") === "NTLMSSP\0");
  check("type1 type=1", t1.readUInt32LE(8) === 1);

  // Synthetic type2 (challenge) message: parse + type3 round-trip.
  const challenge = ntlm.hexToBytes("0123456789abcdef");
  const ti = ntlm.utf16le("DOMAIN.LOCAL");
  const t2 = new Uint8Array(48 + ti.length);
  t2.set([0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00], 0);
  t2[8] = 2; // type 2
  t2.set(challenge, 24);
  t2[40] = ti.length & 0xff; t2[41] = ti.length >> 8; // TargetInfo len
  t2[44] = 48; t2[45] = 0; t2[46] = 0; t2[47] = 0;    // TargetInfo offset
  t2.set(ti, 48);
  const parsed = ntlm.parseType2Message(Buffer.from(t2).toString("base64"));
  check("type2 challenge parsed",
    ntlm.bytesToHex(parsed.challenge) === "0123456789abcdef" && parsed.targetInfo.length === ti.length,
    ntlm.bytesToHex(parsed.challenge));

  const t3 = Buffer.from(ntlm.buildType3Message({
    user: "user@example.com", domain: "", password: "secret", type2: Buffer.from(t2).toString("base64"),
  }), "base64");
  check("type3 signature+type", t3.subarray(0, 8).toString("latin1") === "NTLMSSP\0" && t3.readUInt32LE(8) === 3);
  // Security buffer fields: LM@12, NT@20, Domain@28, User@36, WS@44, Key@52.
  const ntLen = t3.readUInt16LE(20);
  const ntOff = t3.readUInt32LE(24);
  const userLen = t3.readUInt16LE(36);
  const userOff = t3.readUInt32LE(40);
  check("type3 nt buffer: off=64+lm(24), len=hmac(16)+blob(28)+targetInfo",
    ntOff === 88 && ntLen === 44 + ti.length,
    "ntLen=" + ntLen + " (want " + (44 + ti.length) + ") ntOff=" + ntOff);
  check("type3 user buffer: len=2*chars, off=88+ntLen",
    userLen === 32 && userOff === 88 + ntLen,
    "userLen=" + userLen + " userOff=" + userOff + " (want 32/" + (88 + ntLen) + ")");
  check("type3 user utf16le in payload",
    t3.subarray(userOff, userOff + userLen).toString("utf-16le") === "user@example.com");
  check("parseIdentity domain-backslash", (() => {
    const p = ntlm.parseIdentity("CORP\\ivan");
    return p.domain === "CORP" && p.user === "ivan";
  })());
  check("parseIdentity upn", (() => {
    const p = ntlm.parseIdentity("ivan@example.com");
    return p.domain === "" && p.user === "ivan@example.com";
  })());
}

console.log(allOk ? "\nALL PASS (offline)" : "\nSOME FAILED");
process.exit(allOk ? 0 : 1);
