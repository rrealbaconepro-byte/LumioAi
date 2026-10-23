// Chat: sending, rendering, copy buttons, opening and starting chats.
import { callFn } from "./firebase.js";
import * as data from "./data.js";
import { renderMarkdown } from "./markdown.js";
import { createStar, explodeStar } from "./animation.js";
import * as att from "./attachments.js";
import * as learner from "./learner.js";
import { $, esc, copyText, toast } from "./utils.js";

let currentId = null;
let busy = false;
let history = []; // { role, text, images? } — what the model sees
let scroller, messagesEl, emptyEl, inputEl, sendBtn;

export function init() {
  scroller = $("chat-view");
  messagesEl = $("messages");
  emptyEl = $("empty-state");
  inputEl = $("input");
  sendBtn = $("send-btn");

  sendBtn.addEventListener("click", send);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener("input", autoGrow);
  messagesEl.addEventListener("click", onCopyClick);
  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => {
      inputEl.value = b.dataset.prompt;
      autoGrow();
      inputEl.focus();
    })
  );
  att.bindAttachments();
}

export function getCurrentId() {
  return currentId;
}

export function newChat() {
  if (busy) return;
  currentId = null;
  history = [];
  messagesEl.innerHTML = "";
  emptyEl.classList.remove("hidden");
  notifyChatChanged();
}

export async function openChat(id) {
  if (busy) return;
  currentId = id;
  history = [];
  messagesEl.innerHTML = "";
  const msgs = await data.loadMessages(id);
  if (!msgs.length) emptyEl.classList.remove("hidden");
  for (const m of msgs) {
    if (m.role === "user") {
      renderUser(addRow("user"), m.text, [], m.imageNames || []);
      history.push({ role: "user", text: m.text });
    } else {
      renderAssistant(addRow("assistant"), m.text, m.sources || [], false);
      history.push({ role: "assistant", text: m.text });
    }
  }
  scrollDown();
  notifyChatChanged();
}

export async function send() {
  if (busy) return;
  const text = inputEl.value.trim();
  const pending = att.getPending();
  if (!text && !pending.length) return;

  busy = true;
  sendBtn.disabled = true;
  learner.setBusy(true);
  inputEl.value = "";
  autoGrow();

  const images = pending.map(({ name, mime, data: b64 }) => ({ name, mime, data: b64 }));
  const previews = pending.map((p) => p.preview);
  att.clear();

  let userEntry = null;
  let body = null;
  try {
    if (!currentId) {
      currentId = await data.createChat(titleFrom(text || "Image"));
      notifyChatChanged();
    }

    renderUser(addRow("user"), text, previews, []);
    userEntry = { role: "user", text, images };
    history.push(userEntry);
    await data.addMessage(currentId, { role: "user", text, imageNames: images.map((i) => i.name) });

    // "remember that …" saves a memory the AI will use in future chats.
    const mem = text.match(/^remember(?: that)?\s+(.+)/i);
    if (mem) {
      await data.addMemory(mem[1]);
      learner.refresh();
      toast("Saved to memory 🧠");
    }

    body = addRow("assistant");
    const star = createStar("Lumio is thinking…");
    body.append(star);
    scrollDown();

    const memories = (await data.listMemories()).slice(0, 20).map((m) => m.text);
    const res = await callFn("chat", {
      messages: buildPayload(),
      webSearch: $("web-toggle").checked,
      memories,
    });

    await new Promise((resolve) => explodeStar(star, resolve));
    renderAssistant(body, res.text, res.sources || [], true);
    history.push({ role: "assistant", text: res.text });
    await data.addMessage(currentId, { role: "assistant", text: res.text, sources: res.sources || [] });
    await data.touchChat(currentId);
    scrollDown();
  } catch (err) {
    console.error(err);
    if (userEntry) history = history.filter((h) => h !== userEntry);
    const target = body || addRow("assistant");
    target.innerHTML = `<div class="md error-text">Lumio hit a snag: ${esc(err.message || "unknown error")}. Please try again.</div>`;
  } finally {
    busy = false;
    sendBtn.disabled = false;
    learner.setBusy(false);
    inputEl.focus();
  }
}

// ---------- helpers ----------

function buildPayload() {
  const recent = history.slice(-30);
  const last = recent.length - 1;
  return recent.map((h, i) => ({
    role: h.role,
    text: h.text,
    images: i === last && h.images ? h.images : undefined,
  }));
}

function addRow(role) {
  emptyEl.classList.add("hidden");
  const row = document.createElement("article");
  row.className = `msg ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "assistant" ? "✦" : "You";
  const body = document.createElement("div");
  body.className = "msg-body";
  row.append(avatar, body);
  messagesEl.append(row);
  scrollDown();
  return body;
}

function renderUser(body, text, previews = [], imageNames = []) {
  if (previews.length) {
    const grid = document.createElement("div");
    grid.className = "user-images";
    previews.forEach((src) => {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "Attached image";
      grid.append(img);
    });
    body.append(grid);
  } else if (imageNames.length) {
    const note = document.createElement("div");
    note.className = "muted small";
    note.textContent = `🖼 ${imageNames.length} image(s): ${imageNames.join(", ")}`;
    body.append(note);
  }
  if (text) {
    const p = document.createElement("div");
    p.className = "user-text";
    p.textContent = text;
    body.append(p);
  }
}

function renderAssistant(body, text, sources = [], animate = false) {
  body.innerHTML = "";
  const content = document.createElement("div");
  content.className = "md" + (animate ? " reveal" : "");
  content.innerHTML = renderMarkdown(text);
  body.append(content);

  if (sources.length) {
    const s = document.createElement("div");
    s.className = "sources";
    s.innerHTML =
      "Sources: " +
      sources
        .map((x, i) => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">[${i + 1}] ${esc(x.title)}</a>`)
        .join(" ");
    body.append(s);
  }

  const bar = document.createElement("div");
  bar.className = "actions";
  const copy = document.createElement("button");
  copy.className = "chip";
  copy.dataset.copyMsg = "1";
  copy.textContent = "Copy";
  copy._text = text; // raw Markdown, exactly what Lumio sent
  bar.append(copy);
  body.append(bar);
}

function onCopyClick(e) {
  const codeBtn = e.target.closest("[data-copy-code]");
  if (codeBtn) {
    const el = document.getElementById(codeBtn.dataset.copyCode);
    if (el) copyText(el.textContent, codeBtn);
    return;
  }
  const msgBtn = e.target.closest("[data-copy-msg]");
  if (msgBtn) copyText(msgBtn._text, msgBtn);
}

function scrollDown() {
  scroller.scrollTop = scroller.scrollHeight;
}

function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}

function titleFrom(text) {
  return text.replace(/\s+/g, " ").slice(0, 42) || "New chat";
}

function notifyChatChanged() {
  window.dispatchEvent(new CustomEvent("lumio:chat", { detail: { id: currentId } }));
}
