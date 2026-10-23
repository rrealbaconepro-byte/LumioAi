// Entry point: auth screens, view switching, right sidebar, settings.
import {
  auth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "./firebase.js";
import * as data from "./data.js";
import * as chat from "./chat.js";
import * as imagegen from "./imagegen.js";
import * as schedule from "./schedule.js";
import * as learner from "./learner.js";
import { $, toast } from "./utils.js";

const VIEWS = { chat: "chat-view", image: "image-view", schedule: "schedule-view" };
let unsubChats = null;
let lastChats = [];
let initialised = false;

// ---------- Auth screens ----------

function setAuthMode(mode) {
  $("login-form").classList.toggle("hidden", mode !== "login");
  $("signup-form").classList.toggle("hidden", mode !== "signup");
  $("auth-error").textContent = "";
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-credential": "Email or password is wrong.",
    "auth/user-not-found": "No account with that email.",
    "auth/wrong-password": "Email or password is wrong.",
    "auth/email-already-in-use": "That email already has an account. Try logging in.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Use at least 6 characters for the password.",
    "auth/popup-closed-by-user": "The Google window was closed before finishing.",
    "auth/too-many-requests": "Too many attempts. Wait a moment and try again.",
  };
  return map[code] || err?.message || "Something went wrong.";
}

function bindAuth() {
  document.querySelectorAll("[data-goto]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      setAuthMode(a.dataset.goto);
    })
  );

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-pass").value);
    } catch (err) {
      $("auth-error").textContent = friendlyAuthError(err);
    }
  });

  $("signup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("signup-name").value.trim();
    const pass = $("signup-pass").value;
    if (pass.length < 6) {
      $("auth-error").textContent = "Use at least 6 characters for the password.";
      return;
    }
    try {
      const cred = await createUserWithEmailAndPassword(auth, $("signup-email").value.trim(), pass);
      await updateProfile(cred.user, { displayName: name });
      await data.saveProfile(name);
    } catch (err) {
      $("auth-error").textContent = friendlyAuthError(err);
    }
  });

  $("google-login").addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (err) {
      $("auth-error").textContent = friendlyAuthError(err);
    }
  });
}

// ---------- App lifecycle ----------

onAuthStateChanged(auth, (user) => {
  if (user) enterApp(user);
  else leaveApp();
});

function enterApp(user) {
  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("user-label").textContent = user.displayName || user.email || "Signed in";

  if (!initialised) {
    initialised = true;
    chat.init();
    imagegen.init();
    schedule.init();
    bindApp();
  }

  unsubChats?.();
  unsubChats = data.watchChats((list) => {
    lastChats = list;
    renderHistory(list);
  });
  schedule.start();
  learner.start();
  chat.newChat();
  showView("chat");
}

function leaveApp() {
  unsubChats?.();
  unsubChats = null;
  lastChats = [];
  schedule.stop();
  learner.stop();
  $("app-view").classList.add("hidden");
  $("auth-view").classList.remove("hidden");
}

// ---------- Views & sidebar ----------

function showView(name) {
  for (const [key, id] of Object.entries(VIEWS)) {
    $(id).classList.toggle("hidden", key !== name);
  }
  $("composer").classList.toggle("hidden", name !== "chat");
  document.querySelectorAll(".side-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("sidebar").classList.remove("open");
}

function renderHistory(list) {
  const box = $("history-list");
  const active = chat.getCurrentId();
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = `<p class="muted small">No chats yet. Say hi ✦</p>`;
    return;
  }
  for (const c of list) {
    const row = document.createElement("div");
    row.className = "history-item" + (c.id === active ? " active" : "");

    const title = document.createElement("button");
    title.className = "history-title";
    title.textContent = c.title || "New chat";
    title.addEventListener("click", async () => {
      await chat.openChat(c.id);
      showView("chat");
    });

    const del = document.createElement("button");
    del.className = "icon-btn small";
    del.textContent = "🗑";
    del.title = "Delete chat";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this chat?")) return;
      await data.deleteChat(c.id);
      if (chat.getCurrentId() === c.id) chat.newChat();
      toast("Chat deleted");
    });

    row.append(title, del);
    box.append(row);
  }
}

// ---------- Settings & memory ----------

async function renderMemoryList() {
  const box = $("memory-list");
  box.innerHTML = "";
  const list = await data.listMemories();
  if (!list.length) {
    box.innerHTML = `<p class="muted small">Nothing saved yet. Start a message with “remember that …” in chat.</p>`;
    return;
  }
  for (const m of list) {
    const row = document.createElement("div");
    row.className = "mem-item";
    const text = document.createElement("span");
    text.textContent = m.text;
    const del = document.createElement("button");
    del.className = "chip";
    del.textContent = "Forget";
    del.addEventListener("click", async () => {
      await data.deleteMemory(m.id);
      learner.refresh();
      renderMemoryList();
    });
    row.append(text, del);
    box.append(row);
  }
}

// Auth forms exist before login, so they are wired up right away (module scripts run after the DOM is parsed).
bindAuth();

function bindApp() {
  // Sidebar buttons
  $("new-chat-btn").addEventListener("click", () => {
    chat.newChat();
    showView("chat");
  });
  $("image-btn").addEventListener("click", () => showView("image"));
  $("schedule-btn").addEventListener("click", () => showView("schedule"));
  $("logout-btn").addEventListener("click", () => signOut(auth));
  $("toggle-sidebar").addEventListener("click", () => $("sidebar").classList.toggle("open"));

  // Web-search toggle, remembered across visits
  $("web-toggle").checked = localStorage.getItem("lumio.web") === "on";
  $("web-toggle").addEventListener("change", (e) => {
    localStorage.setItem("lumio.web", e.target.checked ? "on" : "off");
    $("set-web").checked = e.target.checked;
  });

  // Settings dialog
  $("open-settings").addEventListener("click", () => {
    $("set-learn").checked = learner.isEnabled();
    $("set-web").checked = $("web-toggle").checked;
    renderMemoryList();
    $("settings-dialog").showModal();
  });
  $("set-learn").addEventListener("change", (e) => learner.setEnabled(e.target.checked));
  $("set-web").addEventListener("change", (e) => {
    $("web-toggle").checked = e.target.checked;
    localStorage.setItem("lumio.web", e.target.checked ? "on" : "off");
  });
  $("mem-add").addEventListener("click", async () => {
    const text = $("mem-input").value.trim();
    if (!text) return;
    await data.addMemory(text);
    $("mem-input").value = "";
    learner.refresh();
    renderMemoryList();
  });

  window.addEventListener("lumio:chat", () => renderHistory(lastChats));
}
