// netlify/functions/_lib/auth.js
//
// Zentrale Rechteprüfung. Jede leader-* und admin-* Function fragt hier,
// wer anfragt. Niemand übernimmt eine leader_id vom Browser.
//
// Leaderinnen: Sitzung im HttpOnly-Cookie "eagle_session". In der Datenbank
// liegt nur der sha256-Hash des Cookie-Werts (Tabelle auth_sessions).
// Übergang: Solange eine Leaderin noch KEIN Passwort gesetzt hat, gilt ihr
// alter persönlicher Link (?id=<token>) weiter. Beim Passwort-Setzen wird der
// alte Token gelöscht, danach öffnet der Link nichts mehr.
//
// Admin: Passwort + E-Mail-Code, Sitzung im Cookie "eagle_admin" (siehe unten).

const crypto = require('crypto');
const { pgrest } = require('./supabase');

const COOKIE_NAME = 'eagle_session';
const SESSION_DAYS = 400; // "angemeldet bleiben, bis sie sich abmeldet" (Browser-Höchstwert für Cookies)
const LOCK_WINDOW_MIN = 15;
const MAX_FAILS_PER_USER = 5;
const MAX_FAILS_PER_IP = 20;
const SETUP_LINK_DAYS = 14;

// ---------- kleine Helfer ----------

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // gleiche Rechenzeit, Ergebnis egal
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function json(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) },
    body: JSON.stringify(obj),
  };
}

function clientIp(event) {
  const h = (event && event.headers) || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
}

function readCookie(event, name) {
  const h = (event && event.headers) || {};
  const raw = h.cookie || h.Cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function sessionCookie(value) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// ---------- Passwörter (scrypt, Node-intern, kein npm-Paket) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('hex'), key.toString('hex')].join('$');
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), keylen: parts[5].length / 2 };
  const key = await scryptAsync(password, Buffer.from(parts[4], 'hex'), params);
  return crypto.timingSafeEqual(key, Buffer.from(parts[5], 'hex'));
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Das Passwort braucht mindestens 8 Zeichen.';
  if (pw.length > 200) return 'Das Passwort ist zu lang.';
  return null;
}

// ---------- Protokoll und Sperre ----------

async function logAccess(leaderId, action, event, detail) {
  try {
    await pgrest('access_log', {
      method: 'POST',
      body: [{ leader_id: leaderId || null, action, detail: detail || null, ip: clientIp(event) }],
    });
  } catch (e) { /* Protokoll darf nie den eigentlichen Vorgang verhindern */ }
}

async function recordAttempt(key, success) {
  try {
    await pgrest('auth_attempts', { method: 'POST', body: [{ attempt_key: key, success: !!success }] });
  } catch (e) { /* ignorieren */ }
}

async function countRecentFails(key) {
  const since = new Date(Date.now() - LOCK_WINDOW_MIN * 60000).toISOString();
  const rows = await pgrest('auth_attempts', {
    query: `attempt_key=eq.${encodeURIComponent(key)}&success=eq.false&created_at=gte.${encodeURIComponent(since)}&select=id&limit=50`,
  });
  return (rows || []).length;
}

// true = gesperrt
async function isLocked(event, username) {
  const ipFails = await countRecentFails('ip:' + clientIp(event));
  if (ipFails >= MAX_FAILS_PER_IP) return true;
  if (username) {
    const userFails = await countRecentFails('user:' + username);
    if (userFails >= MAX_FAILS_PER_USER) return true;
  }
  return false;
}

async function recordFail(event, username) {
  await recordAttempt('ip:' + clientIp(event), false);
  if (username) await recordAttempt('user:' + username, false);
}

// ---------- Sitzungen ----------

// "*" statt einer Spaltenliste: so funktioniert der alte Link auch dann noch,
// wenn supabase/auth.sql noch nicht ausgeführt ist (dann fehlen die neuen Spalten).
// Die Daten bleiben auf dem Server, nach außen geht nur publicLeader().
const LEADER_FIELDS = '*';

async function createSession(leaderId, event) {
  const raw = randomToken(32);
  const ua = ((event && event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '').slice(0, 300);
  await pgrest('auth_sessions', {
    method: 'POST',
    body: [{
      token_hash: sha256(raw),
      leader_id: leaderId,
      expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
      user_agent: ua,
    }],
  });
  return raw;
}

async function leaderFromSession(event) {
  const raw = readCookie(event, COOKIE_NAME);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  const rows = await pgrest('auth_sessions', {
    query: `token_hash=eq.${sha256(raw)}&revoked_at=is.null&select=id,leader_id,expires_at,last_seen_at`,
  });
  const s = rows && rows[0];
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  const leaders = await pgrest('leaders', { query: `id=eq.${s.leader_id}&select=${LEADER_FIELDS}` });
  const leader = leaders && leaders[0];
  if (!leader) return null;
  // Gleitende Gültigkeit: höchstens einmal pro Tag schreiben
  if (Date.now() - new Date(s.last_seen_at).getTime() > 86400000) {
    try {
      await pgrest('auth_sessions', {
        method: 'PATCH',
        query: `id=eq.${s.id}`,
        body: { last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() },
      });
    } catch (e) { /* ignorieren */ }
  }
  return { leader, sessionId: s.id, rawSession: raw };
}

async function revokeSessions(leaderId) {
  await pgrest('auth_sessions', {
    method: 'PATCH',
    query: `leader_id=eq.${leaderId}&revoked_at=is.null`,
    body: { revoked_at: new Date().toISOString() },
  });
}

// Alter Link (?id=<token>), nur solange noch nie ein Passwort gesetzt wurde.
// Nach dem ersten Passwort-Setzen bleibt er für immer ungültig, auch wenn der
// Admin das Passwort später zurücksetzt (dann gilt nur der neue Einmal-Link).
async function leaderFromLegacyToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const rows = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=${LEADER_FIELDS}` });
  const leader = rows && rows[0];
  if (!leader || leader.password_hash || leader.password_set_at) return null;
  return leader;
}

// Einmal-Link zum Passwort-Setzen: alter Token (erste Anmeldung) oder neuer
// Link nach dem Zurücksetzen durch den Admin (nur als Hash gespeichert).
async function leaderFromSetupToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const legacy = await leaderFromLegacyToken(token);
  if (legacy) return legacy;
  const rows = await pgrest('leaders', { query: `setup_token_hash=eq.${sha256(token)}&select=${LEADER_FIELDS}` });
  const leader = rows && rows[0];
  if (!leader) return null;
  if (!leader.setup_token_expires || new Date(leader.setup_token_expires).getTime() < Date.now()) return null;
  return leader;
}

// ---------- die zwei Türsteher ----------

function publicLeader(l) {
  return { id: l.id, name: l.name, slug: l.slug, username: l.username, role: l.role, currentRank: l.current_rank };
}

// Für alle leader-* Functions. Liefert { ok:true, leader } oder { ok:false, response }.
// payload: geparster Body (POST) oder null; bei GET wird ?token= gelesen.
async function requireLeader(event, payload) {
  try {
    const s = await leaderFromSession(event);
    if (s) return { ok: true, leader: s.leader, via: 'session' };
    const legacyToken = (payload && payload.token) || (event.queryStringParameters && event.queryStringParameters.token);
    if (legacyToken) {
      const l = await leaderFromLegacyToken(legacyToken);
      if (l) return { ok: true, leader: l, via: 'legacy' };
    }
  } catch (e) {
    console.error('requireLeader', e.message);
    return { ok: false, response: json(500, { error: 'Anmeldung konnte nicht geprüft werden' }) };
  }
  return { ok: false, response: json(401, { error: 'Nicht angemeldet' }) };
}

// ---------- Admin ----------
//
// Admin meldet sich mit Benutzername + Passwort + 6-stelligem E-Mail-Code an
// (admin-auth.js). Die Sitzung liegt im Cookie "eagle_admin" (7 Tage,
// SameSite=Strict). Der alte Schlüssel ADMIN_SECRET_KEY in der Adresse gilt
// nur noch, solange das Admin-Konto nicht eingerichtet ist (oder die Tabellen
// aus supabase/admin-auth.sql noch fehlen). Er bleibt als Umgebungsvariable,
// weil das Telegram-Geheimnis daraus abgeleitet wird.

const ADMIN_COOKIE = 'eagle_admin';
const ADMIN_SESSION_DAYS = 7;

function adminCookie(value) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_DAYS * 86400}`;
}
function clearAdminCookie() {
  return `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

// null = kein Konto. Wirft, wenn die Tabelle fehlt.
async function getAdminAccount() {
  const rows = await pgrest('admin_account', { query: 'id=eq.1&select=*' });
  return (rows && rows[0]) || null;
}

async function createAdminSession(event) {
  const raw = randomToken(32);
  const ua = ((event && event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '').slice(0, 300);
  await pgrest('admin_sessions', {
    method: 'POST',
    body: [{ token_hash: sha256(raw), expires_at: new Date(Date.now() + ADMIN_SESSION_DAYS * 86400000).toISOString(), user_agent: ua }],
  });
  return raw;
}

// { id } oder null
async function adminFromSession(event) {
  const raw = readCookie(event, ADMIN_COOKIE);
  if (!raw || !/^[0-9a-f]{64}$/.test(raw)) return null;
  const rows = await pgrest('admin_sessions', { query: `token_hash=eq.${sha256(raw)}&revoked_at=is.null&select=id,expires_at` });
  const s = rows && rows[0];
  if (!s || new Date(s.expires_at).getTime() < Date.now()) return null;
  return { id: s.id };
}

function keyMatches(event, payload) {
  const key = (payload && payload.key) || (event.queryStringParameters && event.queryStringParameters.key);
  const expected = process.env.ADMIN_SECRET_KEY;
  return !!(expected && key && safeEqual(key, expected));
}

// Für alle admin-* Functions. Liefert { ok:true, via } oder { ok:false, response }.
async function requireAdmin(event, payload) {
  let accountExists = true;
  try {
    if (await adminFromSession(event)) return { ok: true, via: 'session' };
    accountExists = !!(await getAdminAccount());
  } catch (e) {
    // Tabellen fehlen noch: wie bisher nur mit Schlüssel
    accountExists = false;
  }
  if (!accountExists && keyMatches(event, payload)) return { ok: true, via: 'key' };
  return { ok: false, response: json(403, { error: 'Kein Zugriff' }) };
}

module.exports = {
  COOKIE_NAME,
  SETUP_LINK_DAYS,
  sha256,
  randomToken,
  json,
  clientIp,
  readCookie,
  sessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  passwordProblem,
  logAccess,
  recordAttempt,
  isLocked,
  recordFail,
  createSession,
  leaderFromSession,
  revokeSessions,
  leaderFromSetupToken,
  publicLeader,
  requireLeader,
  requireAdmin,
  ADMIN_COOKIE,
  adminCookie,
  clearAdminCookie,
  getAdminAccount,
  createAdminSession,
  adminFromSession,
  keyMatches,
};
