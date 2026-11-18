// popup.js — unified-toolbar button: sync all + respond to the selected event.
"use strict";

function i18n(key, ...args) {
  return browser.i18n.getMessage(key, args) || key;
}

const $ = id => document.getElementById(id);

function setHint(text) {
  $("hint").textContent = text;
}

async function syncAll() {
  const btn = $("btn-sync");
  btn.disabled = true;
  btn.textContent = i18n("popupSyncing");
  const r = await browser.ews.syncNow(null);
  btn.disabled = false;
  btn.textContent = i18n("popupSyncAll");
  setHint(r.ok ? "" : i18n("errorPrefix", r.error));
}

async function respond(response) {
  const evt = await browser.ews.getSelectedEvent();
  if (!evt) {
    return;
  }
  const r = await browser.ews.respondToMeeting(evt.calendarId, evt.itemId, response);
  setHint(r.ok ? i18n("popupResponded") : i18n("errorPrefix", r.error));
  if (r.ok) {
    $("event-block").hidden = true;
    setHint(i18n("popupResponded"));
  }
}

async function init() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = i18n(el.dataset.i18n);
  });
  $("btn-sync").addEventListener("click", syncAll);
  $("btn-settings").addEventListener("click", () => browser.runtime.openOptionsPage());
  $("btn-accept").addEventListener("click", () => respond("Accept"));
  $("btn-tentative").addEventListener("click", () => respond("Tentative"));
  $("btn-decline").addEventListener("click", () => respond("Decline"));

  const evt = await browser.ews.getSelectedEvent();
  if (evt && evt.isInvitation) {
    $("event-title").textContent = evt.title || evt.itemId;
    $("event-time").textContent = (evt.startISO || "") + " – " + (evt.endISO || "");
    $("event-block").hidden = false;
    setHint("");
  } else if (evt) {
    setHint(i18n("popupNotInvitation"));
  } else {
    setHint(i18n("popupNoSelection"));
  }
}

document.addEventListener("DOMContentLoaded", init);
