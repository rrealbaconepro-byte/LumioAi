/* Lumio backend (Cloud Functions, Node 20).
 *   chat            — the AI: memory + learned knowledge + optional web search + images/code
 *   generateImage   — image generator, saved to Firebase Storage
 *   learn           — idle learning: Wikipedia, Google News, YouTube → Firestore "knowledge"
 * Secrets are set once with:  firebase functions:secrets:set NAME
 */
const crypto = require("crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const REGION = "europe-west1";
const ANTHROPIC_KEY = defineSecret("ANTHROPIC_API_KEY");
const OPENAI_KEY = defineSecret("OPENAI_API_KEY");
const YOUTUBE_KEY = defineSecret("YOUTUBE_API_KEY");
const MODEL = defineString("LUMIO_MODEL", { default: "claude-haiku-5-5" });

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const CHAT_PER_DAY = 300;
const IMAGES_PER_DAY = 40;
const LEARN_PER_HOUR = 30;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const WIKI_HEADERS = { "User-Agent": "LumioApp/1.0 (replace-with-your-contact-email)" };

// ---------------------------------------------------------------- helpers

const clean = (v, max) => String(v ?? "").slice(0, max);

const strip = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please log in first.");
  return req.auth.uid;
}

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Simple per-user counter in Firestore: at most `max` calls per `windowMs`.
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
    if (count >= max) throw new HttpsError("resource-exhausted", "You've reached the limit for now. Try again later.");
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
    getJson(
      `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`
    )
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

// Turns stored messages into Anthropic content blocks; merges same-role neighbours
// and drops leading assistant turns so the API always gets a valid sequence.
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
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY.value(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL.value(), max_tokens: 4096, system, messages }),
    signal: AbortSignal.timeout(110000),
  });
  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text());
    throw new HttpsError("internal", "Lumio couldn't answer right now.");
  }
  const data = await r.json();
  return data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

exports.chat = onCall(
  { region: REGION, secrets: [ANTHROPIC_KEY], timeoutSeconds: 120, memory: "512MiB", maxInstances: 20 },
  async (req) => {
    const uid = requireAuth(req);
    await enforceLimit(uid, "chat", CHAT_PER_DAY, DAY);

    const input = req.data || {};
    const messages = normalizeMessages(Array.isArray(input.messages) ? input.messages : []);
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      throw new HttpsError("invalid-argument", "Send a message first.");
    }

    const question = lastUserText(messages);
    const memories = (Array.isArray(input.memories) ? input.memories : []).slice(0, 20).map((m) => clean(m, 300));
    const [knowledge, sources] = await Promise.all([
      relatedKnowledge(question).catch(() => []),
      input.webSearch ? searchWeb(question).catch(() => []) : Promise.resolve([]),
    ]);

    const text = await callClaude(buildSystem({ memories, knowledge, sources }), messages);
    return {
      text,
      sources: sources.map(({ title, url }) => ({ title, url })),
    };
  }
);

// ---------------------------------------------------------------- images

exports.generateImage = onCall(
  { region: REGION, secrets: [OPENAI_KEY], timeoutSeconds: 180, memory: "512MiB", maxInstances: 10 },
  async (req) => {
    const uid = requireAuth(req);
    await enforceLimit(uid, "image", IMAGES_PER_DAY, DAY);

    const prompt = clean(req.data?.prompt, 1000).trim();
    if (!prompt) throw new HttpsError("invalid-argument", "Write a prompt first.");
    const size = ["1024x1024", "1536x1024", "1024x1536"].includes(req.data?.size) ? req.data.size : "1024x1024";

    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY.value()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size, n: 1 }),
      signal: AbortSignal.timeout(170000),
    });
    if (!r.ok) {
      console.error("Image API error", r.status, await r.text());
      throw new HttpsError("internal", "The image service is unavailable right now.");
    }
    const { data } = await r.json();
    const bytes = Buffer.from(data[0].b64_json, "base64");

    // Store in Firebase Storage and return a tokenised download URL.
    const bucket = admin.storage().bucket();
    const path = `generated/${uid}/${crypto.randomUUID()}.png`;
    const token = crypto.randomUUID();
    await bucket.file(path).save(bytes, {
      metadata: { contentType: "image/png", metadata: { firebaseStorageDownloadTokens: token } },
    });
    const url =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}` +
      `?alt=media&token=${token}`;
    return { url, prompt };
  }
);

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
  const key = YOUTUBE_KEY.value();
  if (!key || key.startsWith("unset")) return [];
  const d = await getJson(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${n}&q=${encodeURIComponent(topic)}&key=${key}`
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

exports.learn = onCall(
  { region: REGION, secrets: [YOUTUBE_KEY], timeoutSeconds: 60, memory: "256MiB", maxInstances: 10 },
  async (req) => {
    const uid = requireAuth(req);
    await enforceLimit(uid, "learn", LEARN_PER_HOUR, HOUR);

    const topic = clean(req.data?.topic, 120).trim();
    if (topic.length < 2) throw new HttpsError("invalid-argument", "Topic missing.");

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
    if (items.length) await batch.commit();

    return { saved: items.length, items: items.map(({ title, source, url }) => ({ title, source, url })) };
  }
);
