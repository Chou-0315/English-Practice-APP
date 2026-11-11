/*
 * England daily reminder — Cloudflare Worker
 *
 * Needs:  a KV namespace bound as  SUBS
 *         a Cron Trigger           * /15 * * * *   (every 15 minutes, written without the space)
 *
 * Routes (called by the England app):
 *   GET  /vapid        -> { key }            public key for push subscriptions (created on first use)
 *   POST /subscribe    { sub, times, tz }    save or update a phone's reminder times (["1200","2000"], "Asia/Taipei")
 *   POST /unsubscribe  { endpoint }          stop reminders for that phone
 *   POST /done         { endpoint, date, streak }   "practised today" -> skip today's reminder
 *   GET  /msg?e=...    -> { title, body }    text for the notification (read by the app's service worker)
 *
 * Pushes carry no payload, so no message encryption is needed: the app's service worker
 * fetches /msg to word the notification.
 */

const ALLOW_ORIGIN = "https://chou-0315.github.io";
const CONTACT = "https://chou-0315.github.io/English-Practice-APP/";

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});
const json = (data, origin, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

/* ---------- helpers ---------- */
const b64u = (buf) => {
  const s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64uStr = (str) => b64u(new TextEncoder().encode(str));
async function idOf(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return "s:" + b64u(h).slice(0, 32);
}
function localNow(tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
  } catch (e) {
    return localNow("Asia/Taipei");
  }
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, mins: +g("hour") * 60 + +g("minute") };
}

/* ---------- VAPID keys (generated once, kept in KV) ---------- */
async function vapid(env) {
  let rec = await env.SUBS.get("vapid", "json");
  if (!rec) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const pub = await crypto.subtle.exportKey("raw", kp.publicKey);
    rec = { priv, pub: b64u(pub) };
    await env.SUBS.put("vapid", JSON.stringify(rec));
  }
  return rec;
}
async function vapidHeader(env, endpoint) {
  const { priv, pub } = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const aud = new URL(endpoint).origin;
  const head = b64uStr(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64uStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pub}`;
}
async function sendPush(env, sub) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { Authorization: await vapidHeader(env, sub.endpoint), TTL: "3600", Urgency: "normal", "Content-Length": "0" },
  });
  return res.status;
}

/* ---------- notification text ---------- */
function message(rec) {
  const s = rec.streak || 0;
  if (s >= 2) return { title: "England 🔥", body: `已經連續 ${s} 天了，今天也練 10 分鐘，別讓火焰熄掉！` };
  if (s === 1) return { title: "England", body: "昨天有練習，今天再來一次就能開始連續天數 🔥" };
  return { title: "England", body: "今天還沒練英文喔，花 10 分鐘把今日訓練做完吧！" };
}

/* ---------- HTTP ---------- */
async function handle(req, env) {
  const url = new URL(req.url), origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });

  if (url.pathname === "/vapid") return json({ key: (await vapid(env)).pub }, origin);

  if (url.pathname === "/msg") {
    const e = url.searchParams.get("e") || "";
    const rec = e ? await env.SUBS.get(await idOf(e), "json") : null;
    return json(message(rec || {}), origin);
  }

  if (req.method !== "POST") return json({ ok: true, app: "england-push" }, origin);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, origin, 400); }

  if (url.pathname === "/subscribe") {
    const sub = b.sub;
    if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint)) return json({ error: "bad subscription" }, origin, 400);
    let times = Array.isArray(b.times) ? b.times : b.time ? [b.time] : [];
    times = [...new Set(times.filter((t) => /^([01]\d|2[0-3])[0-5]\d$/.test(t)))].sort().slice(0, 6);
    if (!times.length) return json({ error: "bad time" }, origin, 400);
    const id = await idOf(sub.endpoint), old = (await env.SUBS.get(id, "json")) || {};
    const rec = { ...old, sub: { endpoint: sub.endpoint }, times, tz: String(b.tz || "Asia/Taipei").slice(0, 64), at: Date.now() };
    await env.SUBS.put(id, JSON.stringify(rec));
    return json({ ok: true }, origin);
  }
  if (url.pathname === "/unsubscribe") {
    if (b.endpoint) await env.SUBS.delete(await idOf(b.endpoint));
    return json({ ok: true }, origin);
  }
  if (url.pathname === "/done") {
    if (!b.endpoint) return json({ error: "no endpoint" }, origin, 400);
    const id = await idOf(b.endpoint), rec = await env.SUBS.get(id, "json");
    if (!rec) return json({ ok: false, error: "not subscribed" }, origin, 404);
    if (rec.done === b.date && rec.streak === b.streak) return json({ ok: true }, origin);
    rec.done = String(b.date || "").slice(0, 10);
    rec.streak = Math.max(0, Math.min(9999, +b.streak || 0));
    await env.SUBS.put(id, JSON.stringify(rec));
    return json({ ok: true }, origin);
  }
  return json({ error: "not found" }, origin, 404);
}

/* ---------- every 15 minutes ---------- */
async function tick(env) {
  let cursor, sent = 0;
  do {
    const page = await env.SUBS.list({ prefix: "s:", cursor });
    cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (!rec || !rec.sub) continue;
      const now = localNow(rec.tz);
      if (rec.done === now.date) continue;
      const times = rec.times || (rec.time ? [rec.time] : []);
      const slot = times.find((x) => { const t = +x.slice(0, 2) * 60 + +x.slice(2); return now.mins >= t && now.mins < t + 15; });
      if (!slot) continue;
      const sentKey = now.date + "@" + slot;
      if ((rec.sentSlots || []).includes(sentKey)) continue;
      const status = await sendPush(env, rec.sub);
      if (status === 404 || status === 410) { await env.SUBS.delete(k.name); continue; }
      if (status < 300) { rec.sentSlots = [...(rec.sentSlots || []).filter((x) => x.startsWith(now.date)), sentKey]; sent++; await env.SUBS.put(k.name, JSON.stringify(rec)); }
    }
  } while (cursor);
  return sent;
}

export default {
  fetch: (req, env) => handle(req, env).catch((e) => json({ error: String(e) }, req.headers.get("Origin") || "", 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(tick(env)),
};
