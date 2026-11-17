// LOCA control panel API - Cloudflare Pages Function (catch-all)
//
// Login is ONE password only - no username, no GitHub - because this
// panel serves a small team. Sessions are signed cookies; the
// "stay signed in" checkbox keeps the user logged in for 30 days per
// device. Changing the password in Settings signs out every OTHER
// device but keeps the current one logged in.
//
// The starting password comes from the PANEL_PASSWORD secret. Once
// the client changes his password inside the panel, the new password
// is stored (salted + PBKDF2-hashed) in the D1 database and the
// secret is no longer used.

const COOKIE_NAME = 'loca_panel';
const PBKDF2_ITERATIONS = 2048;
const STAY_DAYS = 30;
const SESSION_HOURS = 12;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_TRIES = 8;

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8' },
      headers || {}
    ),
  });

const enc = new TextEncoder();

function b64urlFromBytes(bytes) {
  let s = btoa(String.fromCharCode.apply(null, bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  const bytes = new Uint8Array(d);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function constantTimeEqualStr(a, b) {
  const ha = await crypto.subtle.digest('SHA-256', enc.encode(String(a)));
  const hb = await crypto.subtle.digest('SHA-256', enc.encode(String(b)));
  return equalBytes(new Uint8Array(ha), new Uint8Array(hb));
}

async function pbkdf2Bits(password, saltBytes, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iterations },
    base,
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return 'pbkdf2$' + PBKDF2_ITERATIONS + '$' + b64urlFromBytes(salt) + '$' + b64urlFromBytes(bits);
}

async function verifyStoredPassword(stored, password) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = parseInt(parts[1], 10);
    if (!iterations || iterations < 1 || iterations > 200000) return false;
    const got = await pbkdf2Bits(password, bytesFromB64url(parts[2]), iterations);
    return equalBytes(got, bytesFromB64url(parts[3]));
  } catch (e) {
    return false;
  }
}

// ---- signed session cookies ------------------------------------
// token = "v1.<expiryMs>.<era16>.<hmac>"; era changes whenever the
// active password changes, which signs out all other devices.

async function hmacKey(material) {
  const hexKey = await sha256Hex('loca-cookie-v1|' + material);
  return crypto.subtle.importKey('raw', enc.encode(hexKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function eraOf(material) {
  return (await sha256Hex(material)).slice(0, 16);
}

async function signSession(material, expMs) {
  const payload = 'v1.' + expMs + '.' + (await eraOf(material));
  const key = await hmacKey(material);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64urlFromBytes(new Uint8Array(sig));
}

async function verifySession(material, token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const exp = parseInt(parts[1], 10);
    if (!exp || Date.now() >= exp) return false;
    const payload = 'v1.' + parts[1] + '.' + parts[2];
    const key = await hmacKey(material);
    const okSig = await crypto.subtle.verify('HMAC', key, bytesFromB64url(parts[3]), enc.encode(payload));
    if (!okSig) return false;
    const era = await eraOf(material);
    return parts[2] === era;
  } catch (e) {
    return false;
  }
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const pairs = header.split(';');
  for (let i = 0; i < pairs.length; i++) {
    const idx = pairs[i].indexOf('=');
    if (idx === -1) continue;
    if (pairs[i].slice(0, idx).trim() === name) return pairs[i].slice(idx + 1).trim();
  }
  return '';
}

function sessionCookie(token, maxAge) {
  return COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAge;
}

// ---- database ---------------------------------------------------
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch([
        db.prepare(
          "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, created_at TEXT NOT NULL, read_at INTEGER)"
        ),
        db.prepare(
          'CREATE TABLE IF NOT EXISTS panel_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
        ),
        db.prepare(
          'CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at INTEGER NOT NULL)'
        ),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_messages_id ON messages(id DESC)'),
        db.prepare('CREATE INDEX IF NOT EXISTS idx_attempts_clean ON login_attempts(at)'),
      ])
      .then(function () { return true; })
      .catch(function (err) { schemaReady = null; throw err; });
  }
  return schemaReady;
}

// The active password is the D1 hash once the client has changed his
// password; before that it is the PANEL_PASSWORD secret.
async function getActivePassword(env) {
  const row = await env.DB.prepare("SELECT value FROM panel_config WHERE key = 'password_hash'").first();
  if (row && row.value) {
    return {
      material: row.value,
      verify: async function (pw) { return verifyStoredPassword(row.value, pw); },
    };
  }
  const secret = String(env.PANEL_PASSWORD || '').trim();
  if (!secret) return null;
  return {
    material: secret,
    verify: async function (pw) { return constantTimeEqualStr(pw, secret); },
  };
}

async function requireAuth(request, env) {
  const active = await getActivePassword(env);
  if (!active) return null;
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  const valid = await verifySession(active.material, token);
  return valid ? active : null;
}

async function tooManyAttempts(db, ip) {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  await db.prepare('DELETE FROM login_attempts WHERE at < ?1').bind(cutoff).run();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?1').bind(ip).first();
  return ((row && row.n) ? row.n : 0) >= RATE_MAX_TRIES;
}

async function recordFailedAttempt(db, ip) {
  await db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?1, ?2)').bind(ip, Date.now()).run();
}

async function clearAttempts(db, ip) {
  await db.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();
}

function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf;
  const fwd = (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  return fwd || 'unknown';
}

// ---- handlers ----------------------------------------------------
async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const active = await getActivePassword(env);
  if (!active) return json({ ok: false, error: 'Panel is not set up yet: the PANEL_PASSWORD secret is missing.' }, 503);
  const ip = clientIp(request);
  if (await tooManyAttempts(env.DB, ip)) {
    return json({ ok: false, error: 'Too many attempts. Please wait 15 minutes and try again.' }, 429);
  }
  const password = String(body.password || '');
  const ok = password.length > 0 && (await active.verify(password));
  if (!ok) {
    await recordFailedAttempt(env.DB, ip);
    return json({ ok: false, error: 'Wrong password. Please try again.' }, 401);
  }
  await clearAttempts(env.DB, ip);
  const stay = body.stay !== false;
  const maxAge = stay ? STAY_DAYS * 86400 : SESSION_HOURS * 3600;
  const token = await signSession(active.material, Date.now() + maxAge * 1000);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, maxAge) });
}

async function handleLogout() {
  return json({ ok: true }, 200, { 'Set-Cookie': COOKIE_NAME + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
}

async function handlePasswordChange(request, env) {
  const active = await requireAuth(request, env);
  if (!active) return json({ ok: false, error: 'Please sign in again.' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const current = String(body.current || '');
  const next = String(body.next || '');
  if (!(await active.verify(current))) return json({ ok: false, error: 'The current password is wrong.' }, 401);
  if (next.length < 8) return json({ ok: false, error: 'The new password needs at least 8 characters.' }, 422);
  if (next === current) return json({ ok: false, error: 'Choose a password you have not used before.' }, 422);
  const stored = await hashPassword(next);
  await env.DB.prepare(
    "INSERT INTO panel_config (key, value) VALUES ('password_hash', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(stored).run();
  const maxAge = STAY_DAYS * 86400;
  const token = await signSession(stored, Date.now() + maxAge * 1000);
  return json(
    { ok: true, message: 'Password updated. Other devices were signed out.' },
    200,
    { 'Set-Cookie': sessionCookie(token, maxAge) }
  );
}

async function handleInboxGet(request, env) {
  const active = await requireAuth(request, env);
  if (!active) return json({ ok: false, error: 'Please sign in.' }, 401);
  const rows = await env.DB.prepare(
    'SELECT id, name, email, subject, message, created_at, read_at FROM messages ORDER BY id DESC LIMIT 300'
  ).all();
  const all = rows.results || [];
  const unread = all.filter(function (m) { return !m.read_at; }).length;
  return json({ ok: true, unread: unread, total: all.length, messages: all });
}

async function handleInboxPost(request, env) {
  const active = await requireAuth(request, env);
  if (!active) return json({ ok: false, error: 'Please sign in.' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'Invalid request.' }, 400); }
  const action = String(body.action || '');
  if (action === 'clear-read') {
    await env.DB.prepare('DELETE FROM messages WHERE read_at IS NOT NULL').run();
    return json({ ok: true });
  }
  if (action === 'read-all') {
    await env.DB.prepare('UPDATE messages SET read_at = ?1 WHERE read_at IS NULL').bind(Date.now()).run();
    return json({ ok: true });
  }
  const id = parseInt(body.id, 10);
  if (!id || id < 1) return json({ ok: false, error: 'Missing message id.' }, 422);
  if (action === 'read') {
    await env.DB.prepare('UPDATE messages SET read_at = ?1 WHERE id = ?2').bind(Date.now(), id).run();
    return json({ ok: true });
  }
  if (action === 'unread') {
    await env.DB.prepare('UPDATE messages SET read_at = NULL WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  if (action === 'delete') {
    await env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(id).run();
    return json({ ok: true });
  }
  return json({ ok: false, error: 'Unknown action.' }, 422);
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const routeRaw = context.params.route;
  const route = Array.isArray(routeRaw) ? routeRaw.join('/') : String(routeRaw || '');
  if (route.indexOf('/') !== -1) return json({ ok: false, error: 'Not found.' }, 404);
  if (!env.DB) {
    return json({ ok: false, error: 'Panel database is not connected yet (bind the D1 database as DB).' }, 503);
  }
  try {
    await ensureSchema(env.DB);
  } catch (err) {
    console.error('Panel schema error: ' + (err && err.message));
    return json({ ok: false, error: 'Panel database error.' }, 500);
  }
  if (route === 'login' && request.method === 'POST') return handleLogin(request, env);
  if (route === 'logout' && request.method === 'POST') return handleLogout();
  if (route === 'password' && request.method === 'POST') return handlePasswordChange(request, env);
  if (route === 'inbox' && request.method === 'GET') return handleInboxGet(request, env);
  if (route === 'inbox' && request.method === 'POST') return handleInboxPost(request, env);
  return json({ ok: false, error: 'Not found.' }, 404);
}

// exposed for the offline test suite only - not reachable as routes
export const _internals = { hashPassword, verifyStoredPassword, signSession, verifySession, constantTimeEqualStr, PBKDF2_ITERATIONS };
