/* Lumio server — runs on Render as a Node web service.
 *   • serves the website in public/
 *   • POST /api/chat, /api/generateImage, /api/learn — each needs a Firebase login token
 *   • keeps all API keys on the server
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const admin = require("firebase-admin");

// ---------------------------------------------------------------- setup

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT. Paste your service account JSON into Render's environment variables.");
}
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
});
const db = admin.firestore();
const adminAuth = admin.auth();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY || "";
const MODEL = process.env.LUMIO_MODEL || "claude-haiku-5-5";
const PORT = process.env.PORT || 10000;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CHAT_PER_DAY = 300;
const IMAGES_PER_DAY = 40;
const LEARN_PER_HOUR = 30;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const WIKI_HEADERS = { "User-Agent": "LumioApp/1.0 (replace-with-your-contact-email)" };

// ---------------------------------------------------------------- helpers

// Errors with a status are shown to the user; anything else becomes a generic message.
function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = (v, max) => String(v ?? "").slice(0, max);

const strip = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Verifies the Firebase ID token sent by the browser and stores the user id on the request.
async function requireUser(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please log in first." });
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Your session expired. Please log in again." });
  }
}

// Per-user counter in Firestore: at most `max` calls per `windowMs`.
async function enforceLimit(uid, name, max, windowMs) {
  const ref = db.collection("usage").doc(`${uid}_${name}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    let count = 0;
    let start = now;
    if (snap.exists) ({ count = 0, start = now } = snap.data());
    if (now - start > windowMs) {
      count = 0;
      start = now;
    }
    if (count >= max) throw fail(429, "You've reached the limit for now. Try again later.");
    tx.set(ref, { count: count + 1, start });
  });
}

// ---------------------------------------------------------------- web search

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? strip(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : "";
}

async function newsSearch(query, n = 4) {
  const r = await fetch(
    `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n).map(([, block]) => ({
    title: tag(block, "title"),
    url: tag(block, "link"),
    snippet: tag(block, "pubDate"),
    source: "news",
  }));
}

async function searchWeb(query) {
  if (!query) return [];
  const [ddg, wiki, news] = await Promise.all([
    getJson(`https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`)
      .then((d) => (d.AbstractText && d.AbstractURL ? [{ title: d.Heading || query, url: d.AbstractURL, snippet: d.AbstractText }] : []))
      .catch(() => []),
    getJson(`https://en.wikipedia.org/w/rest.php/v1/search/page?limit=3&q=${encodeURIComponent(query)}`, {
      headers: WIKI_HEADERS,
    })
      .then((d) =>
        (d.pages || []).map((p) => ({
          title: strip(p.title),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
          snippet: strip(p.excerpt || p.description),
        }))
      )
      .catch(() => []),
    newsSearch(query, 3).catch(() => []),
  ]);
  return [...ddg, ...wiki, ...news].filter((r) => /^https:\/\//.test(r.url)).slice(0, 6);
}

// ---------------------------------------------------------------- AI

async function relatedKnowledge(text) {
  const words = [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))].slice(0, 10);
  if (!words.length) return [];
  const snap = await db.collection("knowledge").where("keywords", "array-contains-any", words).limit(5).get();
  return snap.docs.map((d) => d.data());
}

function buildSystem({ memories, knowledge, sources }) {
  let s =
    "You are Lumio, a smart, friendly and honest AI assistant. " +
    "Answer clearly and accurately. Use Markdown: short paragraphs, lists when useful, " +
    "and put all code in fenced code blocks with the language name. " +
    "When you are unsure, say so. " +
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`;
  if (memories.length) s += `\n\nThings you remember about the user:\n- ${memories.join("\n- ")}`;
  if (knowledge.length)
    s += `\n\nBackground Lumio has learned (may be incomplete):\n${knowledge
      .map((k) => `- ${k.title}: ${k.summary} (${k.url})`)
      .join("\n")}`;
  if (sources.length)
    s += `\n\nLive web results. Use them when relevant and cite them as [n] with the URL:\n${sources
      .map((x, i) => `[${i + 1}] ${x.title} — ${x.snippet} (${x.url})`)
      .join("\n")}`;
  return s;
}

// Turns stored messages into Anthropic content blocks. Merges same-role neighbours and
// drops leading assistant turns so the API always gets a valid sequence.
function normalizeMessages(raw) {
  const out = [];
  for (const m of raw.slice(-30)) {
    if (!m || !["user", "assistant"].includes(m.role)) continue;
    const blocks = [];
    for (const img of (Array.isArray(m.images) ? m.images : []).slice(0, 8)) {
      if (ALLOWED_MIME.includes(img.mime) && typeof img.data === "string" && img.data.length < 6_000_000) {
        blocks.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data } });
      }
    }
    const text = clean(m.text, 8000).trim();
    if (text || !blocks.length) blocks.push({ type: "text", text: text || "(image)" });

    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

function lastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .slice(0, 2000);
}

async function callClaude(system, messages) {
  if (!ANTHROPIC_KEY) throw fail(503, "The AI key (ANTHROPIC_API_KEY) isn't set on the server yet.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages }),
    signal: AbortSignal.timeout(110000),
  });
  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text());
    throw fail(502, "Lumio couldn't answer right now.");
  }
  const data = await r.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function handleChat(uid, input) {
  await enforceLimit(uid, "chat", CHAT_PER_DAY, DAY);

  const messages = normalizeMessages(Array.isArray(input.messages) ? input.messages : []);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw fail(400, "Send a message first.");
  }

  const question = lastUserText(messages);
  const memories = (Array.isArray(input.memories) ? input.memories : []).slice(0, 20).map((m) => clean(m, 300));
  const [knowledge, sources] = await Promise.all([
    relatedKnowledge(question).catch(() => []),
    input.webSearch ? searchWeb(question).catch(() => []) : Promise.resolve([]),
  ]);

  const text = await callClaude(buildSystem({ memories, knowledge, sources }), messages);
  return { text, sources: sources.map(({ title, url }) => ({ title, url })) };
}

// ---------------------------------------------------------------- images

async function handleGenerateImage(uid, input) {
  await enforceLimit(uid, "image", IMAGES_PER_DAY, DAY);

  const prompt = clean(input.prompt, 1000).trim();
  if (!prompt) throw fail(400, "Write a prompt first.");
  if (!OPENAI_KEY) throw fail(503, "The image key (OPENAI_API_KEY) isn't set on the server yet.");
  const size = ["1024x1024", "1536x1024", "1024x1536"].includes(input.size) ? input.size : "1024x1024";

  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size, n: 1 }),
    signal: AbortSignal.timeout(170000),
  });
  if (!r.ok) {
    console.error("Image API error", r.status, await r.text());
    throw fail(502, "The image service is unavailable right now.");
  }
  const { data } = await r.json();
  return { url: `data:image/png;base64,${data[0].b64_json}`, prompt };
}

// ---------------------------------------------------------------- learning

async function wikiSummaries(topic) {
  const search = await getJson(
    `https://en.wikipedia.org/w/rest.php/v1/search/page?limit=2&q=${encodeURIComponent(topic)}`,
    { headers: WIKI_HEADERS }
  ).catch(() => ({ pages: [] }));

  const out = [];
  for (const p of (search.pages || []).slice(0, 2)) {
    const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(p.key)}`, {
      headers: WIKI_HEADERS,
    }).catch(() => null);
    if (s?.extract) {
      out.push({
        title: s.title,
        summary: s.extract.slice(0, 600),
        url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.key)}`,
        source: "wikipedia",
      });
    }
  }
  return out;
}

async function youtubeSearch(topic, n = 3) {
  if (!YOUTUBE_KEY || YOUTUBE_KEY.startsWith("unset")) return [];
  const d = await getJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${n}&q=${encodeURIComponent(topic)}&key=${YOUTUBE_KEY}`
  ).catch(() => null);
  return (d?.items || [])
    .filter((v) => v.id?.videoId)
    .map((v) => ({
      title: strip(v.snippet.title),
      summary: strip(v.snippet.description).slice(0, 300),
      url: `https://www.youtube.com/watch?v=${v.id.videoId}`,
      source: "youtube",
    }));
}

async function handleLearn(uid, input) {
  await enforceLimit(uid, "learn", LEARN_PER_HOUR, HOUR);

  const topic = clean(input.topic, 120).trim();
  if (topic.length < 2) throw fail(400, "Topic missing.");

  const [wiki, news, videos] = await Promise.all([
    wikiSummaries(topic).catch(() => []),
    newsSearch(topic, 3).catch(() => []),
    youtubeSearch(topic, 3).catch(() => []),
  ]);
  const items = [
    ...wiki,
    ...news.map((n) => ({ title: n.title, summary: n.snippet, url: n.url, source: "news" })),
    ...videos,
  ].filter((i) => i.title && /^https:\/\//.test(i.url));

  const keywords = [...new Set(topic.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))].slice(0, 20);
  if (items.length) {
    const batch = db.batch();
    for (const it of items) {
      // Document id = hash of the URL, so the same page is never stored twice.
      const id = crypto.createHash("sha1").update(it.url).digest("hex");
      batch.set(
        db.collection("knowledge").doc(id),
        {
          topic,
          keywords,
          title: it.title,
          summary: clean(it.summary, 600),
          url: it.url,
          source: it.source,
          learnedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();
  }

  return { saved: items.length, items: items.map(({ title, source, url }) => ({ title, source, url })) };
}

// ---------------------------------------------------------------- web server

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "15mb" })); // room for a few base64 images

app.get("/healthz", (_req, res) => res.send("ok"));

const handlers = { chat: handleChat, generateImage: handleGenerateImage, learn: handleLearn };
for (const [name, handler] of Object.entries(handlers)) {
  app.post(`/api/${name}`, requireUser, async (req, res) => {
    try {
      res.json(await handler(req.uid, req.body || {}));
    } catch (err) {
      if (!err.status) console.error(`[${name}]`, err);
      res.status(err.status || 500).json({
        error: err.status ? err.message : "Something went wrong. Please try again.",
      });
    }
  });
}

// ---------------------------------------------------------------- finding the website
// The site files can be in public/ or flat in the repo, so search the whole project
// for index.html and the other site files. Only safe, web-type files are ever served.

const SERVE_EXT = new Set([".html", ".htm", ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".github"]);
const PROJECT_DIR = __dirname;

function isServable(file) {
  const base = path.basename(file);
  return (
    SERVE_EXT.has(path.extname(base).toLowerCase()) &&
    path.resolve(file) !== path.resolve(__filename) && // never serve server.js
    !/service|adminsdk|\.env/i.test(base) // never serve keys
  );
}

function scan(dir, depth = 0, found = []) {
  if (depth > 8) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) scan(full, depth + 1, found);
    } else if (e.isFile() && isServable(full)) {
      found.push(full);
    }
  }
  return found;
}

// Files inside a "public" folder are preferred when names clash.
const allFiles = scan(PROJECT_DIR).sort((a, b) => {
  const pa = /[\\/]public[\\/]/i.test(a) ? 0 : 1;
  const pb = /[\\/]public[\\/]/i.test(b) ? 0 : 1;
  return pa - pb || a.length - b.length;
});
const byName = new Map(); // lowercase file name -> full path
for (const f of allFiles) {
  const key = path.basename(f).toLowerCase();
  if (!byName.has(key)) byName.set(key, f);
}
const indexFile = byName.get("index.html") || byName.get("index.htm");

console.log(
  indexFile
    ? `Found index.html at ${path.relative(PROJECT_DIR, indexFile)}; serving ${allFiles.length} site files.`
    : `WARNING: index.html not found anywhere in the project. Files found: ${allFiles.length}.`
);

app.get("/", (_req, res) => {
  if (indexFile) return res.redirect(302, "/index.html");
  sendMissing(res);
});

app.get("*", (req, res, next) => {
  let requested;
  try {
    requested = decodeURIComponent(req.path);
  } catch {
    return res.status(400).send("Bad request");
  }

  // 1) exact path inside the project (e.g. /js/app.js or /public/css/styles.css)
  const exact = path.resolve(PROJECT_DIR, "." + requested);
  if (exact.startsWith(PROJECT_DIR + path.sep) && isServable(exact) && fs.existsSync(exact) && fs.statSync(exact).isFile()) {
    return res.sendFile(exact);
  }

  // 2) same file name anywhere in the project (e.g. /css/styles.css when the file sits at the top level)
  const found = byName.get(path.basename(requested).toLowerCase());
  if (found && requested !== "/") return res.sendFile(found);

  // 3) index.html requested under any name
  if (/\/index\.html?$/i.test(requested) && indexFile) return res.sendFile(indexFile);

  next();
});

function sendMissing(res) {
  const names = [...byName.keys()].slice(0, 40).map((n) => `<li>${n.replace(/[<>&]/g, "")}</li>`).join("");
  res
    .status(404)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Lumio: index.html missing</title>` +
        `<body style="font-family:sans-serif;padding:24px"><h2>index.html was not found</h2>` +
        `<p>The server searched the whole project for index.html and found none. Check that index.html is in the repo.</p>` +
        `<p>Site files the server can see:</p><ul>${names || "<li>none</li>"}</ul></body>`
    );
}

app.use((_req, res) => sendMissing(res));

app.listen(PORT, () => {
  console.log(`Lumio is running on port ${PORT}`);
});
