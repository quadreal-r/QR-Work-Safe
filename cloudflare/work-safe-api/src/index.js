/**
 * Work Safe API — auth, contacts, GPS check-in (email + SMS), per-worker logs.
 */

const TOKEN_TTL_HOURS = 90 * 24;
const WORKER_NAME_MAX = 80;
const ADDRESS_MAX = 500;
const LOGS_LIMIT = 200;
const CONTACTS_MAX = 50;

const ALLOWED_ORIGINS = new Set([
  "https://work-safe-tracker.quadreal-rpiwin.workers.dev",
  "https://quadreal-r.github.io",
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
  "http://127.0.0.1",
]);

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  Vary: "Origin",
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    ...SECURITY_HEADERS,
  };
  // Allow LAN live-reload during development (http://192.168.x.x:port).
  if (
    ALLOWED_ORIGINS.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/i.test(origin) ||
    /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/i.test(origin)
  ) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(request, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64url(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  return Uint8Array.from(
    atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad),
    (c) => c.charCodeAt(0)
  );
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function constantTimeEqual(a, b) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(String(a ?? ""))),
    crypto.subtle.sign("HMAC", key, enc.encode(String(b ?? ""))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function requireAuthSecret(env) {
  return typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.length > 0;
}

function tokenEpoch(env) {
  return String(env.TOKEN_EPOCH ?? "1");
}

function randomHex(bytes = 4) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uuid() {
  return crypto.randomUUID();
}

async function mintToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_HOURS * 3600;
  const iat = now;
  const jti = randomHex(16);
  const epoch = tokenEpoch(env);
  const payload = `wsafe|${exp}|${iat}|${jti}|${epoch}`;
  const key = await hmacKey(env.AUTH_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(sig)}`;
}

async function verifyToken(env, token) {
  if (!token || !requireAuthSecret(env)) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const payload = new TextDecoder().decode(fromB64url(parts[0]));
    const [kind, expStr, iatStr, jti, epoch] = payload.split("|");
    if (kind !== "wsafe") return false;
    if (!jti || !iatStr) return false;
    if (epoch !== tokenEpoch(env)) return false;
    const exp = Number(expStr);
    const iat = Number(iatStr);
    if (!exp || !iat || exp * 1000 < Date.now()) return false;
    if (iat > Math.floor(Date.now() / 1000) + 60) return false;
    const key = await hmacKey(env.AUTH_SECRET);
    const sig = fromB64url(parts[1]);
    return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function rateLimitOr429(request, limiter, key, periodSec) {
  if (!limiter || typeof limiter.limit !== "function") return null;
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return json(
    request,
    { ok: false, error: "Too many requests" },
    429,
    { "Retry-After": String(periodSec) }
  );
}

function supabaseReady(env) {
  return (
    typeof env.SUPABASE_URL === "string" &&
    env.SUPABASE_URL.startsWith("https://") &&
    typeof env.SUPABASE_SERVICE_KEY === "string" &&
    env.SUPABASE_SERVICE_KEY.length > 0
  );
}

async function supabaseCall(env, path, init = {}) {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: init.prefer || "return=representation",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: res.status, detail };
  }
  const text = await res.text();
  if (!text) return { data: null };
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: 502 };
  }
}

function supabaseErrorMessage(result, fallback) {
  if (!result || !result.error) return fallback;
  if (result.error === 401 || result.error === 403) {
    return "Database key rejected — set SUPABASE_SERVICE_KEY to the service_role / sb_secret key";
  }
  return fallback;
}

function normalizeWorkerName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, WORKER_NAME_MAX);
}

function normalizeEmail(email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 160) return null;
  return e;
}

/** Keep digits and leading +; require 10–15 digits for SMS. */
function normalizePhone(phone) {
  let p = String(phone || "").trim();
  if (!p) return null;
  p = p.replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (!p.startsWith("+")) {
    // North America default when no country code.
    if (digits.length === 10) p = "+1" + digits;
    else if (digits.length === 11 && digits.startsWith("1")) p = "+" + digits;
    else return null;
  }
  return p.slice(0, 20);
}

function cleanContact(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (!name) return null;
  const email = normalizeEmail(raw.email);
  const phone = normalizePhone(raw.phone);
  if (!email && !phone) return null;
  return {
    id: typeof raw.id === "string" && /^[0-9a-f-]{36}$/i.test(raw.id) ? raw.id : uuid(),
    name,
    email,
    phone,
    active: raw.active === false ? false : true,
  };
}

async function reverseGeocode(lat, lng) {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=0`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "QuadReal-Work-Safe/1.0 (field safety check-in)",
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const display = String(data.display_name || "").trim();
    return display ? display.slice(0, ADDRESS_MAX) : null;
  } catch {
    return null;
  }
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function eventLabel(type) {
  return type === "safe_ground" ? "SAFE ON GROUND" : "ON SITE / CLIMBING";
}

function buildMessage(workerName, eventType, address, lat, lng, occurredAt) {
  const label = eventLabel(eventType);
  const when = formatWhen(occurredAt);
  const maps = `https://maps.google.com/?q=${lat},${lng}`;
  const text =
    `QuadReal Work Safe — ${label}\n` +
    `Worker: ${workerName}\n` +
    `When: ${when}\n` +
    `Address: ${address || "(unknown)"}\n` +
    `GPS: ${lat.toFixed(6)}, ${lng.toFixed(6)}\n` +
    `Map: ${maps}`;
  const html =
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#131622;line-height:1.45">` +
    `<h2 style="color:#173073;margin:0 0 12px">${label}</h2>` +
    `<p><b>Worker:</b> ${escapeHtml(workerName)}</p>` +
    `<p><b>When:</b> ${escapeHtml(when)}</p>` +
    `<p><b>Address:</b> ${escapeHtml(address || "(unknown)")}</p>` +
    `<p><b>GPS:</b> ${lat.toFixed(6)}, ${lng.toFixed(6)}</p>` +
    `<p><a href="${maps}">Open in Google Maps</a></p>` +
    `<p style="color:#666D82;font-size:12px;margin-top:18px">QuadReal Work Safe</p></div>`;
  return { text, html, subject: `[Work Safe] ${workerName} — ${label}` };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendEmail(env, to, subject, html, text) {
  if (!to) return { ok: false, reason: "no_email" };
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
    return { ok: false, reason: "email_not_configured" };
  }
  const fromEmail = env.EMAIL_FROM || "noreply@example.com";
  const fromName = env.EMAIL_FROM_NAME || "QuadReal Work Safe";
  try {
    await env.EMAIL.send({
      to,
      from: { email: fromEmail, name: fromName },
      subject,
      html,
      text,
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: (e && e.message) || "email_failed",
      detail: String((e && e.message) || e || "").slice(0, 240),
    };
  }
}

function normalizeE164(phone) {
  let p = String(phone || "").trim();
  if (!p) return null;
  p = p.replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  const digits = p.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  if (!p.startsWith("+")) {
    if (digits.length === 10) p = "+1" + digits;
    else if (digits.length === 11 && digits.startsWith("1")) p = "+" + digits;
    else return null;
  }
  return p;
}

function telnyxReady(env) {
  const from = normalizeE164(env.TELNYX_FROM_NUMBER);
  return (
    typeof env.TELNYX_API_KEY === "string" &&
    env.TELNYX_API_KEY.trim().length > 8 &&
    !!from
  );
}

function plivoReady(env) {
  const from = normalizeE164(env.PLIVO_FROM_NUMBER);
  return (
    typeof env.PLIVO_AUTH_ID === "string" &&
    env.PLIVO_AUTH_ID.length > 0 &&
    typeof env.PLIVO_AUTH_TOKEN === "string" &&
    env.PLIVO_AUTH_TOKEN.length > 0 &&
    !!from
  );
}

function twilioReady(env) {
  const from = normalizeE164(env.TWILIO_FROM_NUMBER);
  return (
    typeof env.TWILIO_ACCOUNT_SID === "string" &&
    env.TWILIO_ACCOUNT_SID.startsWith("AC") &&
    typeof env.TWILIO_AUTH_TOKEN === "string" &&
    env.TWILIO_AUTH_TOKEN.length > 0 &&
    !!from
  );
}

/** Prefer Telnyx, then Plivo, then Twilio — whichever secrets are present. */
function smsProvider(env) {
  if (telnyxReady(env)) return "telnyx";
  if (plivoReady(env)) return "plivo";
  if (twilioReady(env)) return "twilio";
  return null;
}

async function sendSmsTelnyx(env, to, body) {
  const from = normalizeE164(env.TELNYX_FROM_NUMBER);
  const payload = {
    from,
    to,
    text: body.slice(0, 1500),
  };
  // Optional: set when the From number alone is not enough for the account.
  if (env.TELNYX_MESSAGING_PROFILE_ID) {
    payload.messaging_profile_id = String(env.TELNYX_MESSAGING_PROFILE_ID).trim();
  }
  const res = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let reason = `telnyx_${res.status}`;
    try {
      const j = JSON.parse(detail);
      const err = j?.errors?.[0];
      if (err?.code) reason = `telnyx_${err.code}`;
      if (err?.detail || err?.title) {
        return {
          ok: false,
          reason,
          detail: String(err.detail || err.title).slice(0, 240),
        };
      }
    } catch (_) {}
    return { ok: false, reason, detail: detail.slice(0, 240) };
  }
  return { ok: true, provider: "telnyx" };
}

async function sendSmsPlivo(env, to, body) {
  const authId = env.PLIVO_AUTH_ID;
  const from = normalizeE164(env.PLIVO_FROM_NUMBER);
  const url = `https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}/Message/`;
  const auth = btoa(`${authId}:${env.PLIVO_AUTH_TOKEN}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      src: from,
      dst: to,
      text: body.slice(0, 1500),
    }),
  });
  // Plivo returns 202 on accept.
  if (!res.ok && res.status !== 202) {
    const detail = await res.text().catch(() => "");
    return { ok: false, reason: `plivo_${res.status}`, detail: detail.slice(0, 200) };
  }
  return { ok: true, provider: "plivo" };
}

async function sendSmsTwilio(env, to, body) {
  const sid = env.TWILIO_ACCOUNT_SID;
  const from = normalizeE164(env.TWILIO_FROM_NUMBER);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({
    To: to,
    From: from,
    Body: body.slice(0, 1500),
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, reason: `twilio_${res.status}`, detail: detail.slice(0, 200) };
  }
  return { ok: true, provider: "twilio" };
}

async function sendSms(env, to, body) {
  if (!to) return { ok: false, reason: "no_phone" };
  const provider = smsProvider(env);
  if (!provider) return { ok: false, reason: "sms_not_configured" };
  try {
    if (provider === "telnyx") return await sendSmsTelnyx(env, to, body);
    if (provider === "plivo") return await sendSmsPlivo(env, to, body);
    return await sendSmsTwilio(env, to, body);
  } catch (e) {
    return { ok: false, reason: (e && e.message) || "sms_failed" };
  }
}

async function requireSignedIn(request, env) {
  if (!requireAuthSecret(env)) {
    return { error: json(request, { ok: false, error: "Server misconfigured" }, 500) };
  }
  const token = bearer(request);
  if (!(await verifyToken(env, token))) {
    return { error: json(request, { ok: false, error: "Sign in required" }, 401) };
  }
  if (!supabaseReady(env)) {
    return { error: json(request, { ok: false, error: "Database not configured" }, 503) };
  }
  return { token };
}

async function handleContactsGet(request, env) {
  const { data, error } = await supabaseCall(
    env,
    "work_safe_contacts?select=id,name,email,phone,active,updated_at&order=name.asc"
  );
  if (error) {
    return json(
      request,
      { ok: false, error: supabaseErrorMessage({ error }, "Contacts unavailable") },
      502
    );
  }
  return json(request, { ok: true, contacts: Array.isArray(data) ? data : [] });
}

async function handleContactsPut(request, env, deviceId) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, error: "Invalid JSON" }, 400);
  }
  if (!Array.isArray(body.contacts)) {
    return json(request, { ok: false, error: "contacts must be an array" }, 400);
  }
  if (body.contacts.length > CONTACTS_MAX) {
    return json(request, { ok: false, error: "Too many contacts" }, 413);
  }

  const cleaned = [];
  const seen = new Set();
  for (const raw of body.contacts) {
    const c = cleanContact(raw);
    if (!c) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    cleaned.push(c);
  }

  // Replace-all: delete missing, upsert remaining.
  const { data: existing, error: listErr } = await supabaseCall(
    env,
    "work_safe_contacts?select=id"
  );
  if (listErr) {
    return json(
      request,
      { ok: false, error: supabaseErrorMessage({ error: listErr }, "Contacts unavailable") },
      502
    );
  }
  const keep = new Set(cleaned.map((c) => c.id));
  const toDelete = (Array.isArray(existing) ? existing : [])
    .map((r) => r.id)
    .filter((id) => !keep.has(id));

  for (const id of toDelete) {
    await supabaseCall(env, `work_safe_contacts?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      prefer: "return=minimal",
    });
  }

  const now = new Date().toISOString();
  const rows = cleaned.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    active: c.active,
    updated_at: now,
    updated_by: deviceId || null,
  }));

  if (rows.length) {
    const { error: upErr } = await supabaseCall(env, "work_safe_contacts?on_conflict=id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: JSON.stringify(rows),
    });
    if (upErr) {
      return json(
        request,
        { ok: false, error: supabaseErrorMessage({ error: upErr }, "Could not save contacts") },
        502
      );
    }
  }

  return handleContactsGet(request, env);
}

async function handleCheckin(request, env, deviceId) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(request, { ok: false, error: "Invalid JSON" }, 400);
  }

  const workerName = normalizeWorkerName(body.workerName);
  if (!workerName) {
    return json(request, { ok: false, error: "Worker name required" }, 400);
  }

  const eventType = body.eventType === "safe_ground" ? "safe_ground" : "on_site";
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return json(request, { ok: false, error: "Valid GPS coordinates required" }, 400);
  }

  let occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())) occurredAt = new Date();
  // Cap future clock skew to 2 minutes.
  const now = Date.now();
  if (occurredAt.getTime() > now + 120000) occurredAt = new Date(now);
  const occurredIso = occurredAt.toISOString();

  let sessionId =
    typeof body.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(body.sessionId)
      ? body.sessionId
      : null;
  if (eventType === "on_site") {
    sessionId = sessionId || uuid();
  } else if (!sessionId) {
    return json(request, { ok: false, error: "sessionId required for safe_ground" }, 400);
  }

  const recipientIds = Array.isArray(body.recipientIds)
    ? body.recipientIds.filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 20)
    : [];
  if (!recipientIds.length) {
    return json(request, { ok: false, error: "Select at least one contact to notify" }, 400);
  }

  const idFilter = recipientIds.map((id) => `"${id}"`).join(",");
  const { data: contacts, error: cErr } = await supabaseCall(
    env,
    `work_safe_contacts?select=id,name,email,phone,active&id=in.(${idFilter})&active=eq.true`
  );
  if (cErr) return json(request, { ok: false, error: "Contacts unavailable" }, 502);
  const list = Array.isArray(contacts) ? contacts : [];
  if (!list.length) {
    return json(request, { ok: false, error: "No active contacts matched" }, 400);
  }

  let address = typeof body.address === "string" ? body.address.trim().slice(0, ADDRESS_MAX) : "";
  if (!address) {
    address = (await reverseGeocode(lat, lng)) || "";
  }

  const msg = buildMessage(workerName, eventType, address, lat, lng, occurredIso);
  const recipients = [];
  for (const c of list) {
    const emailResult = await sendEmail(env, c.email, msg.subject, msg.html, msg.text);
    const smsResult = await sendSms(env, c.phone, msg.text);
    recipients.push({
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      email_ok: !!emailResult.ok,
      sms_ok: !!smsResult.ok,
      email_reason: emailResult.ok ? null : emailResult.reason || null,
      sms_reason: smsResult.ok ? null : smsResult.reason || null,
      email_detail: emailResult.ok ? null : emailResult.detail || null,
      sms_detail: smsResult.ok ? null : smsResult.detail || null,
    });
  }

  const row = {
    id: uuid(),
    worker_name: workerName,
    event_type: eventType,
    lat,
    lng,
    address: address || null,
    occurred_at: occurredIso,
    recipients,
    device_id: deviceId || null,
    session_id: sessionId,
  };

  const { data: inserted, error: iErr } = await supabaseCall(env, "work_safe_events", {
    method: "POST",
    body: JSON.stringify(row),
  });
  if (iErr) return json(request, { ok: false, error: "Could not save event" }, 502);

  const saved = Array.isArray(inserted) ? inserted[0] : inserted;
  return json(request, {
    ok: true,
    event: saved || row,
    sessionId,
    address: address || null,
    recipients,
  });
}

async function handleLogs(request, env, url) {
  const worker = normalizeWorkerName(url.searchParams.get("worker") || "");
  let path =
    `work_safe_events?select=id,worker_name,event_type,lat,lng,address,occurred_at,recipients,session_id,device_id,created_at` +
    `&order=occurred_at.desc&limit=${LOGS_LIMIT}`;
  if (worker) {
    path += `&worker_name=eq.${encodeURIComponent(worker)}`;
  }
  const { data, error } = await supabaseCall(env, path);
  if (error) return json(request, { ok: false, error: "Logs unavailable" }, 502);
  const events = Array.isArray(data) ? data : [];

  // Distinct worker names for the filter UI (recent first).
  const { data: namesData } = await supabaseCall(
    env,
    "work_safe_events?select=worker_name&order=occurred_at.desc&limit=500"
  );
  const names = [];
  const seen = new Set();
  for (const r of Array.isArray(namesData) ? namesData : []) {
    const n = r.worker_name;
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    names.push(n);
    if (names.length >= 100) break;
  }

  return json(request, { ok: true, events, workers: names });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/" || path === "/api/health")) {
      const provider = smsProvider(env);
      return json(request, {
        ok: true,
        service: "work-safe-api",
        email: !!(env.EMAIL && typeof env.EMAIL.send === "function"),
        sms: !!provider,
        smsProvider: provider,
        smsHints: {
          hasTelnyxKey: !!(env.TELNYX_API_KEY && String(env.TELNYX_API_KEY).trim().length > 8),
          hasTelnyxFrom: !!normalizeE164(env.TELNYX_FROM_NUMBER),
          hasPlivo: plivoReady(env),
          hasTwilio: twilioReady(env),
        },
        db: supabaseReady(env),
      });
    }

    if (path === "/api/login") {
      if (request.method !== "POST") {
        return json(request, { ok: false, error: "Method not allowed" }, 405, {
          Allow: "POST, OPTIONS",
        });
      }
      const limited = await rateLimitOr429(
        request,
        env.LOGIN_LIMITER,
        `login:${clientIp(request)}`,
        60
      );
      if (limited) return limited;
      if (!requireAuthSecret(env) || !env.AUTH_PASSWORD) {
        return json(request, { ok: false, error: "Server misconfigured" }, 500);
      }
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const password = String(body.password || "");
      const match = await constantTimeEqual(password, env.AUTH_PASSWORD);
      if (!match) {
        return json(request, { ok: false, error: "Invalid password" }, 401);
      }
      const token = await mintToken(env);
      return json(request, { ok: true, token, expiresInHours: TOKEN_TTL_HOURS });
    }

    if (path === "/api/me") {
      if (request.method !== "GET") {
        return json(request, { ok: false, error: "Method not allowed" }, 405, {
          Allow: "GET, OPTIONS",
        });
      }
      if (!requireAuthSecret(env)) {
        return json(request, { ok: false, error: "Server misconfigured" }, 500);
      }
      const ok = await verifyToken(env, bearer(request));
      return ok
        ? json(request, { ok: true, signedIn: true })
        : json(request, { ok: false, signedIn: false }, 401);
    }

    if (path === "/api/contacts") {
      if (request.method !== "GET" && request.method !== "PUT") {
        return json(request, { ok: false, error: "Method not allowed" }, 405, {
          Allow: "GET, PUT, OPTIONS",
        });
      }
      const auth = await requireSignedIn(request, env);
      if (auth.error) return auth.error;
      const limited = await rateLimitOr429(
        request,
        env.DATA_LIMITER,
        `data:${await sha256Hex(auth.token)}`,
        60
      );
      if (limited) return limited;
      if (request.method === "GET") return handleContactsGet(request, env);
      let deviceId = "";
      try {
        const peek = await request.clone().json();
        deviceId = String(peek.deviceId || "").slice(0, 64);
      } catch {}
      return handleContactsPut(request, env, deviceId);
    }

    if (path === "/api/checkin") {
      if (request.method !== "POST") {
        return json(request, { ok: false, error: "Method not allowed" }, 405, {
          Allow: "POST, OPTIONS",
        });
      }
      const auth = await requireSignedIn(request, env);
      if (auth.error) return auth.error;
      const limited = await rateLimitOr429(
        request,
        env.CHECKIN_LIMITER,
        `checkin:${await sha256Hex(auth.token)}`,
        60
      );
      if (limited) return limited;
      let deviceId = "";
      try {
        const peek = await request.clone().json();
        deviceId = String(peek.deviceId || "").slice(0, 64);
      } catch {}
      return handleCheckin(request, env, deviceId);
    }

    if (path === "/api/logs") {
      if (request.method !== "GET") {
        return json(request, { ok: false, error: "Method not allowed" }, 405, {
          Allow: "GET, OPTIONS",
        });
      }
      const auth = await requireSignedIn(request, env);
      if (auth.error) return auth.error;
      const limited = await rateLimitOr429(
        request,
        env.DATA_LIMITER,
        `logs:${await sha256Hex(auth.token)}`,
        60
      );
      if (limited) return limited;
      return handleLogs(request, env, url);
    }

    if (path.startsWith("/api/")) {
      return json(request, { ok: false, error: "Not found" }, 404);
    }
    return json(request, { ok: false, error: "Not found" }, 404);
  },
};
