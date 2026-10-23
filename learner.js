// Idle learning: after LEARN_IDLE_MS with no activity, Lumio fetches short summaries
// (Wikipedia, Google News, YouTube) about topics you care about and stores them.
// Any interaction pauses it. Capped per hour; can be switched off in Settings.
import { callFn } from "./firebase.js";
import { LEARN_IDLE_MS, LEARN_MAX_PER_HOUR } from "./config.js";
import * as data from "./data.js";
import { $, shuffle } from "./utils.js";

const DEFAULT_TOPICS = [
  "latest world news",
  "artificial intelligence",
  "space exploration",
  "programming languages",
  "technology news",
  "mathematics",
  "physics discoveries",
  "music history",
  "climate science",
  "philosophy",
];
const STAMPS_KEY = "lumio.learnStamps";
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart", "wheel"];

let enabled = localStorage.getItem("lumio.learn") !== "off";
let active = false; // signed in and app visible
let listening = false;
let busy = false; // Lumio is answering a chat message
let idleTimer = null;
let cycle = 0; // bumped on every interaction; old loops exit when it changes
let memoryTopics = [];
let pool = [...DEFAULT_TOPICS];
let turn = 0;

export function start() {
  active = true;
  if (!listening) {
    ACTIVITY.forEach((ev) => window.addEventListener(ev, touch, { passive: true }));
    document.addEventListener("visibilitychange", touch);
    listening = true;
  }
  refresh();
  touch();
}

export function stop() {
  active = false;
  cycle++;
  clearTimeout(idleTimer);
  status(null);
}

export function isEnabled() {
  return enabled;
}

export function setEnabled(value) {
  enabled = value;
  localStorage.setItem("lumio.learn", value ? "on" : "off");
  touch();
}

export function setBusy(value) {
  busy = value;
  if (value) {
    cycle++;
    clearTimeout(idleTimer);
    status(null);
  } else {
    touch();
  }
}

// Refresh the list of topics from the user's memories (things they care about).
export function refresh() {
  data
    .listMemories()
    .then((list) => {
      memoryTopics = list.slice(0, 10).map((m) => m.text.slice(0, 60));
      pool = shuffle([...memoryTopics, ...DEFAULT_TOPICS]);
    })
    .catch(() => {});
}

// Any activity: cancel the current learning loop and restart the 4-second idle countdown.
function touch() {
  cycle++;
  clearTimeout(idleTimer);
  status(null);
  if (active && enabled && !busy && !document.hidden) {
    idleTimer = setTimeout(learnLoop, LEARN_IDLE_MS);
  }
}

async function learnLoop() {
  const my = cycle;
  while (my === cycle && enabled && !busy && hasQuota()) {
    const topic = nextTopic();
    status(`Learning about ${topic}…`);
    const res = await callFn("learn", { topic }).catch(() => null);
    if (my !== cycle) break;
    if (!res) break; // server refused or failed: stop until the next idle period
    stamp();
    status(res.saved ? `Learned ${res.saved} new things about ${topic}` : `Nothing new about ${topic}`);
    await wait(LEARN_IDLE_MS);
    if (my !== cycle) break;
  }
  if (my === cycle) status(null);
}

function nextTopic() {
  const topic = pool[turn % pool.length];
  turn++;
  return topic;
}

function readStamps() {
  const now = Date.now();
  try {
    return JSON.parse(localStorage.getItem(STAMPS_KEY) || "[]").filter((t) => now - t < 3600e3);
  } catch {
    return [];
  }
}

function hasQuota() {
  return readStamps().length < LEARN_MAX_PER_HOUR;
}

function stamp() {
  const stamps = readStamps();
  stamps.push(Date.now());
  localStorage.setItem(STAMPS_KEY, JSON.stringify(stamps));
}

function status(text) {
  const el = $("learn-pill");
  if (!el) return;
  if (!text || !enabled) {
    el.classList.add("hidden");
    el.textContent = "";
  } else {
    el.classList.remove("hidden");
    el.textContent = "🧠 " + text;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
