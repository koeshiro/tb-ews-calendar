// options.js — settings page: list, add/edit, delete and per-calendar sync.
"use strict";

const $ = id => document.getElementById(id);

function i18n(key, ...args) {
  return browser.i18n.getMessage(key, args) || key;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = i18n(el.dataset.i18n);
  });
}

function showStatus(text, isError) {
  const line = $("status-line");
  line.textContent = text;
  line.classList.toggle("error", !!isError);
}

let editingId = null;

async function renderList() {
  const list = $("calendar-list");
  list.textContent = "";
  const cals = await browser.ews.listCalendars();
  $("no-calendars").hidden = cals.length > 0;
  for (const c of cals) {
    const row = document.createElement("div");
    row.className = "calendar-row";

    const dot = document.createElement("span");
    dot.className = "dot " + (c.lastSyncOk ? "ok" : c.lastSyncError ? "fail" : "none");
    dot.title = c.lastSyncError
      ? i18n("statusFail") + " " + c.lastSyncError
      : c.lastSyncOk
        ? i18n("statusOk") + (c.lastSyncTime ? " (" + c.lastSyncTime + ")" : "")
        : i18n("statusNever");
    row.appendChild(dot);

    const main = document.createElement("div");
    main.className = "grow";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = c.name || c.email;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent =
      c.email + (c.readOnly ? " · RO" : "") + " · " + c.refreshInterval + " min" +
      (c.lastSyncCount ? " · " + c.lastSyncCount + " ev" : "");
    main.append(title, sub);
    row.appendChild(main);

    const mkBtn = (key, fn, cls) => {
      const b = document.createElement("button");
      b.textContent = i18n(key);
      b.addEventListener("click", fn);
      if (cls) {
        b.className = cls;
      }
      return b;
    };

    row.appendChild(mkBtn("syncCalendar", async () => {
      showStatus(i18n("popupSyncing"));
      const r = await browser.ews.syncNow(c.id);
      showStatus(r.ok ? i18n("saved") : i18n("errorPrefix", r.error), !r.ok);
      await renderList();
    }));
    row.appendChild(mkBtn("editCalendar", () => openForm(c)));
    row.appendChild(mkBtn("deleteCalendar", async () => {
      if (!confirm(i18n("confirmDelete", c.name || c.email))) {
        return;
      }
      await browser.ews.removeCalendar(c.id);
      await renderList();
    }));

    list.appendChild(row);
  }
}

function openForm(cal) {
  editingId = cal ? cal.id : null;
  $("form-title").textContent = cal ? i18n("editCalendar") : i18n("addCalendar");
  $("f-url").value = cal ? cal.url : "";
  $("f-email").value = cal ? cal.email : "";
  $("f-name").value = cal ? cal.name : "";
  $("f-auth").value = cal ? cal.authMethod : "auto";
  $("f-password").value = "";
  $("password-hint").hidden = !(cal && cal.hasPassword);
  $("f-interval").value = cal ? cal.refreshInterval : 30;
  $("f-readonly").checked = !!(cal && cal.readOnly);
  $("form-section").hidden = false;
  $("list-section").hidden = true;
  showStatus("");
}

function closeForm() {
  editingId = null;
  $("form-section").hidden = true;
  $("list-section").hidden = false;
}

async function saveForm() {
  const cfg = {
    url: $("f-url").value.trim(),
    email: $("f-email").value.trim(),
    displayName: $("f-name").value.trim(),
    authMethod: $("f-auth").value,
    password: $("f-password").value,
    refreshInterval: parseInt($("f-interval").value, 10) || 30,
    readOnly: $("f-readonly").checked,
  };
  if (!cfg.url || !cfg.email) {
    showStatus(i18n("errorPrefix", "url/email"), true);
    return;
  }
  let r;
  if (editingId) {
    r = await browser.ews.updateCalendar(editingId, cfg);
  } else {
    r = await browser.ews.createCalendar(cfg);
  }
  if (r && r.error) {
    showStatus(i18n("errorPrefix", r.error), true);
    return;
  }
  showStatus(i18n("saved"));
  closeForm();
  await renderList();
}

async function testConnection() {
  const cfg = {
    url: $("f-url").value.trim(),
    email: $("f-email").value.trim(),
    authMethod: $("f-auth").value,
    password: $("f-password").value,
  };
  if (!cfg.url) {
    showStatus(i18n("errorPrefix", "url"), true);
    return;
  }
  showStatus(i18n("testingConnection"));
  const r = await browser.ews.testConnection(cfg, editingId);
  if (r.ok) {
    showStatus(i18n("testOk") + " (HTTP " + r.httpCode + (r.authPath ? ", " + r.authPath : "") + ")");
  } else {
    showStatus(i18n("errorPrefix", (r.error || "HTTP " + r.httpCode) + (r.authPath ? " [" + r.authPath + "]" : "")), true);
  }
}

async function init() {
  applyI18n();
  $("btn-add").addEventListener("click", () => openForm(null));
  $("btn-save").addEventListener("click", saveForm);
  $("btn-test").addEventListener("click", testConnection);
  $("btn-cancel").addEventListener("click", closeForm);
  await renderList();
}

document.addEventListener("DOMContentLoaded", init);
