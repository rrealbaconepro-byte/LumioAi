// Schedule view: reminders stored per user. Due items show a toast (and a browser
// notification if allowed) while the Lumio tab is open.
import * as data from "./data.js";
import { $, esc, toast } from "./utils.js";

const DAY = 864e5;
const WEEK = 6048e5;

let items = [];
let unsub = null;
let timer = null;
const fired = new Set();

export function init() {
  $("schedule-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("sch-title").value.trim();
    const when = new Date($("sch-when").value);
    if (!title || isNaN(when)) return toast("Add a title and a time.");
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    await data.addSchedule({
      title,
      notes: $("sch-notes").value.trim(),
      runAt: when,
      repeat: $("sch-repeat").value,
      done: false,
    });
    e.target.reset();
    toast("Scheduled ✓");
  });

  $("schedule-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const item = items.find((i) => i.id === btn.dataset.id);
    if (!item) return;
    if (btn.dataset.act === "done") await data.updateSchedule(item.id, { done: !item.done });
    if (btn.dataset.act === "del") await data.deleteSchedule(item.id);
  });
}

export function start() {
  stop();
  unsub = data.watchSchedules((list) => {
    items = list;
    render();
    checkDue();
  });
  timer = setInterval(checkDue, 15000);
}

export function stop() {
  unsub?.();
  unsub = null;
  clearInterval(timer);
  items = [];
  render();
}

function labelRepeat(r) {
  return r === "daily" ? "Daily" : r === "weekly" ? "Weekly" : "Once";
}

function render() {
  const list = $("schedule-list");
  list.innerHTML = "";
  if (!items.length) {
    list.innerHTML = `<p class="muted">Nothing scheduled yet.</p>`;
    return;
  }
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "sch-item" + (it.done ? " done" : "");
    row.innerHTML = `
      <div class="sch-main">
        <strong>${esc(it.title)}</strong>
        <div class="muted small">${esc(it.runAt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))} · ${labelRepeat(it.repeat)}</div>
        ${it.notes ? `<div class="small">${esc(it.notes)}</div>` : ""}
      </div>
      <div class="sch-actions">
        <button class="chip" data-act="done" data-id="${esc(it.id)}">${it.done ? "Undo" : "Done"}</button>
        <button class="chip" data-act="del" data-id="${esc(it.id)}">Delete</button>
      </div>`;
    list.append(row);
  }
}

function checkDue() {
  const now = Date.now();
  for (const it of items) {
    if (it.done) continue;
    const t = it.runAt.getTime();
    const key = `${it.id}:${t}`;
    if (t > now || fired.has(key)) continue;
    fired.add(key);

    toast(`⏰ ${it.title}`, 6000);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("Lumio reminder", { body: it.title });
    }

    if (it.repeat === "none") {
      data.updateSchedule(it.id, { done: true });
    } else {
      const step = it.repeat === "daily" ? DAY : WEEK;
      let next = t + step;
      while (next <= now) next += step;
      data.updateSchedule(it.id, { runAt: new Date(next) });
    }
  }
}
