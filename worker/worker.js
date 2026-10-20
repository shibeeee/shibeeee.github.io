// Backend for the homepage's visitor counter and guestbook.
//
// GitHub Pages only serves static files, so this small Cloudflare Worker keeps
// the count and the guestbook messages in a Durable Object (SQLite storage,
// included in the free plan). wrangler.toml at the repo root deploys it.
//
//   POST   /api/visit            count one visit, returns { visits }
//   GET    /api/stats            returns { visits }
//   GET    /api/guestbook        newest messages, ?before=<id> for older ones
//   POST   /api/guestbook        { name, message, website } (website is a bot trap)
//   DELETE /api/guestbook/<id>   remove a message; needs "Authorization: Bearer <ADMIN_TOKEN>"
//   GET    /api/youtube          latest uploads from the youtube channel, refreshed hourly

import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = ["https://shibeeee.github.io"];
const PAGE_SIZE = 20;
const NAME_MAX = 32;
const MESSAGE_MAX = 500;
const POST_GAP_MS = 60 * 1000; // one message per minute per visitor
const POSTS_PER_DAY = 5; // per visitor
const YOUTUBE = "https://www.youtube.com/@shibereal/videos";
const YOUTUBE_EVERY_MS = 60 * 60 * 1000; // check the channel at most once an hour
const VIDEOS_MAX = 6;

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        time INTEGER NOT NULL,
        visitor TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_visitor ON entries (visitor, time);
      CREATE TABLE IF NOT EXISTS saved (key TEXT PRIMARY KEY, value TEXT NOT NULL, time INTEGER NOT NULL);
    `);
  }

  // Small key-value store for things fetched from elsewhere (the youtube list)
  load(key) {
    const row = this.sql.exec("SELECT value, time FROM saved WHERE key = ?", key).toArray()[0];
    return row ? { value: JSON.parse(row.value), time: row.time } : null;
  }

  save(key, value) {
    this.sql.exec(
      "INSERT INTO saved (key, value, time) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, time = excluded.time",
      key, JSON.stringify(value), Date.now()
    );
  }

  visits() {
    const row = this.sql.exec("SELECT value FROM counters WHERE key = 'visits'").toArray()[0];
    return row ? row.value : 0;
  }

  addVisit() {
    this.sql.exec(
      "INSERT INTO counters (key, value) VALUES ('visits', 1) ON CONFLICT (key) DO UPDATE SET value = value + 1"
    );
    return this.visits();
  }

  list(before) {
    const rows = this.sql
      .exec(
        "SELECT id, name, message, time FROM entries WHERE id < ? ORDER BY id DESC LIMIT ?",
        before || Number.MAX_SAFE_INTEGER,
        PAGE_SIZE + 1
      )
      .toArray();
    return { entries: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  post(name, message, visitor) {
    const now = Date.now();
    const recent = this.sql
      .exec("SELECT time FROM entries WHERE visitor = ? AND time > ? ORDER BY time DESC", visitor, now - 86400000)
      .toArray();
    if (recent.length >= POSTS_PER_DAY) return { error: "that's enough messages for today, come back tomorrow!" };
    if (recent.length && now - recent[0].time < POST_GAP_MS) return { error: "slow down a little, try again in a minute" };
    const row = this.sql
      .exec(
        "INSERT INTO entries (name, message, time, visitor) VALUES (?, ?, ?, ?) RETURNING id, name, message, time",
        name, message, now, visitor
      )
      .toArray()[0];
    return { entry: row };
  }

  remove(id) {
    this.sql.exec("DELETE FROM entries WHERE id = ?", id);
    return { ok: true };
  }
}

function cors(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(request) },
  });
}

// Trim, drop control characters (keeping line breaks in messages) and cap the length.
function clean(text, max, multiline) {
  if (typeof text !== "string") return "";
  text = text.replace(multiline ? /[^\P{C}\n]/gu : /\p{C}/gu, "");
  if (multiline) text = text.replace(/\n{3,}/g, "\n\n");
  else text = text.replace(/\s+/g, " ");
  return text.trim().slice(0, max);
}

// Guestbook filter -----------------------------------------------------------
// Words that get a message rejected. Matched as whole words after undoing the
// usual tricks (leetspeak, accents, repeated letters), so "class" or "Scunthorpe"
// still get through.
const BLOCKED_WORDS = [
  "fuck", "fucking", "fucker", "fucked", "fuk", "fck", "shit", "shitty", "bullshit", "bitch", "bitches",
  "cunt", "dick", "dicks", "cock", "cocks", "pussy", "asshole", "ass", "bastard", "whore", "slut", "twat",
  "wanker", "porn", "porno", "nude", "nudes", "penis", "vagina", "boobs", "tits", "cum", "dildo", "rape",
  "rapist", "kys", "nazi", "hitler", "retard", "retarded", "fag", "fags", "kike", "chink", "spic", "gook",
  "tranny", "coon", "wetback", "beaner", "dyke",
];
// Slurs bad enough to catch even when spaced out ("n i g g e r") or hidden in
// longer words. Only long, unambiguous ones belong here.
const BLOCKED_ANYWHERE = ["nigger", "nigga", "faggot", "killyourself", "retarded"];

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i", "+": "t" };

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "") // é -> e
    .replace(/[0134578@$!|+]/g, (c) => LEET[c]);
}

const collapse = (word) => word.replace(/(.)\1+/g, "$1"); // fuuuck -> fuck
const BLOCKED_SET = new Set(BLOCKED_WORDS);
// Collapsed spellings too, minus the ones that collapse into normal words (ass -> as, coon -> con)
const COLLAPSED_SET = new Set(BLOCKED_WORDS.map(collapse).filter((w) => !["as", "con", "bobs", "gok"].includes(w)));
const isBlocked = (w) => BLOCKED_SET.has(w) || COLLAPSED_SET.has(collapse(w));
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+(\.|\s*(\(dot\)|\[dot\])\s*)(com|net|org|io|ru|xyz|top|ly|gg|co|info|biz|site|online|link|click|shop|app|me|tk|cn)\b)/i;

// Returns a friendly reason when the text isn't allowed, otherwise null.
function filterReason(text) {
  if (LINK.test(text)) return "no links in the guestbook please!";
  const plain = normalize(text);
  const words = plain.split(/[^a-z]+/).filter(Boolean);
  if (words.some(isBlocked)) return "let's keep it friendly! try different words :)";
  // Single letters spaced out: "f u c k" -> "fuck"
  const joined = plain.replace(/\b([a-z])[^a-z]+(?=[a-z]\b)/g, "$1");
  if (joined.split(/[^a-z]+/).some(isBlocked)) return "let's keep it friendly! try different words :)";
  const squashed = plain.replace(/[^a-z]/g, "");
  if (BLOCKED_ANYWHERE.some((w) => squashed.includes(w))) return "let's keep it friendly! try different words :)";
  return null;
}

// Tone down keyboard mashing: "!!!!!!!!!!" -> "!!!", "aaaaaaaaaa" -> "aaaaa"
function tidy(text) {
  return text.replace(/([^\w\s])\1{3,}/g, "$1$1$1").replace(/(\w)\1{5,}/g, "$1$1$1$1$1");
}

// YouTube ---------------------------------------------------------------------
// The channel's RSS feed 404s, and the Data API needs a key, so this reads the
// list YouTube builds into the channel's videos page.
async function fetchVideos() {
  const res = await fetch(YOUTUBE + "?hl=en&gl=US", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "SOCS=CAI", // skip the cookie consent page in europe
    },
  });
  if (!res.ok) throw new Error("youtube " + res.status);
  const html = await res.text();
  const data = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!data) throw new Error("no ytInitialData");
  const videos = [];
  (function walk(node) {
    if (!node || typeof node !== "object" || videos.length >= VIDEOS_MAX) return;
    const lockup = node.lockupViewModel;
    if (lockup && lockup.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
      const meta = lockup.metadata?.lockupMetadataViewModel;
      const parts = (meta?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap((r) => r.metadataParts || []);
      const label = (re) => (parts.find((p) => re.test(p.accessibilityLabel || "")) || {}).accessibilityLabel || "";
      const badge = JSON.stringify(lockup.contentImage || {}).match(/"text":"(\d+(?::\d+)+)"/);
      videos.push({
        id: lockup.contentId,
        title: meta?.title?.content || "",
        views: label(/views?$/),
        ago: label(/ago$/),
        length: badge ? badge[1] : "",
      });
      return;
    }
    Object.values(node).forEach(walk);
  })(JSON.parse(data[1]));
  const subs = html.match(/"([\d.,]+[KM]? subscribers?)"/);
  return { videos: videos.filter((v) => /^[\w-]{11}$/.test(v.id)), subscribers: subs ? subs[1] : "" };
}

// Hash the IP so rate limits work without storing anyone's address.
async function visitorId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("shibeeee-guestbook:" + ip));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = env.STORE.get(env.STORE.idFromName("main"));
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });

    // Writes only from the homepage itself
    const fromHomepage = ALLOWED_ORIGINS.includes(request.headers.get("Origin"));

    if (url.pathname === "/api/stats" && method === "GET") {
      return json(request, { visits: await store.visits() });
    }

    if (url.pathname === "/api/visit" && method === "POST") {
      if (!fromHomepage) return json(request, { error: "not allowed" }, 403);
      return json(request, { visits: await store.addVisit() });
    }

    if (url.pathname === "/api/guestbook" && method === "GET") {
      const before = parseInt(url.searchParams.get("before"), 10);
      return json(request, await store.list(before > 0 ? before : 0));
    }

    if (url.pathname === "/api/guestbook" && method === "POST") {
      if (!fromHomepage) return json(request, { error: "not allowed" }, 403);
      let body;
      try {
        body = await request.json();
      } catch {
        return json(request, { error: "that didn't look right, try again" }, 400);
      }
      // Bots fill in every field; people never see this one
      if (body.website) return json(request, { entry: null });
      const name = tidy(clean(body.name, NAME_MAX, false));
      const message = tidy(clean(body.message, MESSAGE_MAX, true));
      if (!name || !message) return json(request, { error: "add your name and a message first" }, 400);
      const reason = filterReason(name) || filterReason(message);
      if (reason) return json(request, { error: reason }, 400);
      const result = await store.post(name, message, await visitorId(request));
      return json(request, result, result.error ? 429 : 200);
    }

    if (url.pathname === "/api/youtube" && method === "GET") {
      const saved = await store.load("youtube");
      if (saved && Date.now() - saved.time < YOUTUBE_EVERY_MS) return json(request, saved.value);
      try {
        const fresh = await fetchVideos();
        if (!fresh.videos.length) throw new Error("no videos found");
        await store.save("youtube", fresh);
        return json(request, fresh);
      } catch (err) {
        // YouTube changed something or is down: an old list is better than none
        if (saved) return json(request, saved.value);
        return json(request, { error: String(err.message || err) }, 502);
      }
    }

    const del = url.pathname.match(/^\/api\/guestbook\/(\d+)$/);
    if (del && method === "DELETE") {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json(request, { error: "not allowed" }, 403);
      return json(request, await store.remove(Number(del[1])));
    }

    return json(request, { error: "not found" }, 404);
  },
};
