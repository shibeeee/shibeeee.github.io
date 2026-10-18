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

import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGINS = ["https://shibeeee.github.io"];
const PAGE_SIZE = 20;
const NAME_MAX = 32;
const MESSAGE_MAX = 500;
const POST_GAP_MS = 60 * 1000; // one message per minute per visitor
const POSTS_PER_DAY = 5; // per visitor

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
    `);
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
      const name = clean(body.name, NAME_MAX, false);
      const message = clean(body.message, MESSAGE_MAX, true);
      if (!name || !message) return json(request, { error: "add your name and a message first" }, 400);
      const result = await store.post(name, message, await visitorId(request));
      return json(request, result, result.error ? 429 : 200);
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
