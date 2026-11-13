// netlify/functions/auth.js
//
// Anmeldung fürs Leader-Dashboard.
//
// GET  ?action=me                              -> wer ist angemeldet? (frischt das Cookie auf)
// POST { action:"setup-check", token }         -> gehört der Einmal-Link zu jemandem? (Name, Benutzername)
// POST { action:"setup", token, password, consent:true }
//                                              -> Passwort festlegen, Link entwerten, anmelden
// POST { action:"login", username, password }  -> anmelden
// POST { action:"logout" }                     -> abmelden (nur dieses Gerät)
// POST { action:"consent" }                    -> Zustimmung nachholen (angemeldete Leaderin)

const { pgrest } = require('./_lib/supabase');
const A = require('./_lib/auth');

// Eine feste, gültige Hash-Zeichenkette, damit eine Anmeldung mit unbekanntem
// Namen gleich lange dauert wie mit bekanntem (sonst verrät die Zeit die Namen).
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = A.hashPassword('nicht-das-passwort-' + A.randomToken(8));
  return dummyHashPromise;
}

function normUser(u) {
  return String(u || '').trim().toLowerCase().slice(0, 60);
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      const action = event.queryStringParameters && event.queryStringParameters.action;
      if (action !== 'me') return A.json(400, { error: 'Unbekannte Aktion' });
      const s = await A.leaderFromSession(event);
      if (!s) return A.json(200, { loggedIn: false });
      return A.json(
        200,
        { loggedIn: true, leader: A.publicLeader(s.leader), needsConsent: !s.leader.consent_at },
        { 'Set-Cookie': A.sessionCookie(s.rawSession) }
      );
    }

    if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method Not Allowed' });

    let p;
    try {
      p = JSON.parse(event.body || '{}');
    } catch (e) {
      return A.json(400, { error: 'Ungültiges JSON' });
    }

    // ---------- Einmal-Link prüfen ----------
    if (p.action === 'setup-check') {
      if (await A.isLocked(event)) return A.json(429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const l = await A.leaderFromSetupToken(p.token);
      if (!l) {
        await A.recordFail(event);
        return A.json(404, { error: 'Dieser Link ist nicht mehr gültig.' });
      }
      return A.json(200, { name: l.name, username: l.username });
    }

    // ---------- Passwort festlegen ----------
    if (p.action === 'setup') {
      if (await A.isLocked(event)) return A.json(429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const l = await A.leaderFromSetupToken(p.token);
      if (!l) {
        await A.recordFail(event);
        return A.json(404, { error: 'Dieser Link ist nicht mehr gültig.' });
      }
      const problem = A.passwordProblem(p.password);
      if (problem) return A.json(400, { error: problem });
      if (p.consent !== true) return A.json(400, { error: 'Bitte bestätige die Zustimmung.' });
      if (!l.username) return A.json(500, { error: 'Für dich ist noch kein Benutzername hinterlegt. Bitte melde dich bei Dominik.' });

      const now = new Date().toISOString();
      await pgrest('leaders', {
        method: 'PATCH',
        query: `id=eq.${l.id}`,
        body: {
          password_hash: await A.hashPassword(p.password),
          password_set_at: now,
          consent_at: l.consent_at || now,
          token: 'used-' + A.randomToken(24), // alter Link ist damit entwertet (Spalte ist "not null")
          setup_token_hash: null,
          setup_token_expires: null,
        },
      });
      await A.revokeSessions(l.id);
      const raw = await A.createSession(l.id, event);
      await A.logAccess(l.id, 'password_set', event);
      if (!l.consent_at) await A.logAccess(l.id, 'consent', event);
      return A.json(
        200,
        { ok: true, leader: A.publicLeader(l), username: l.username },
        { 'Set-Cookie': A.sessionCookie(raw) }
      );
    }

    // ---------- Anmelden ----------
    if (p.action === 'login') {
      const username = normUser(p.username);
      if (!username || typeof p.password !== 'string' || !p.password) {
        return A.json(400, { error: 'Bitte Benutzername und Passwort eingeben.' });
      }
      if (await A.isLocked(event, username)) {
        return A.json(429, { error: 'Zu viele falsche Versuche. Bitte in 15 Minuten nochmal.' });
      }
      const rows = await pgrest('leaders', {
        query: `username=eq.${encodeURIComponent(username)}&select=id,name,slug,username,role,current_rank,password_hash,consent_at`,
      });
      const l = rows && rows[0];
      const ok = await A.verifyPassword(p.password, (l && l.password_hash) || (await dummyHash()));
      if (!l || !l.password_hash || !ok) {
        await A.recordFail(event, username);
        await A.logAccess(l ? l.id : null, 'login_failed', event, username);
        return A.json(401, { error: 'Benutzername oder Passwort stimmt nicht.' });
      }
      const raw = await A.createSession(l.id, event);
      await A.logAccess(l.id, 'login', event);
      return A.json(
        200,
        { ok: true, leader: A.publicLeader(l), needsConsent: !l.consent_at },
        { 'Set-Cookie': A.sessionCookie(raw) }
      );
    }

    // ---------- Abmelden ----------
    if (p.action === 'logout') {
      const s = await A.leaderFromSession(event);
      if (s) {
        await pgrest('auth_sessions', {
          method: 'PATCH',
          query: `id=eq.${s.sessionId}`,
          body: { revoked_at: new Date().toISOString() },
        });
        await A.logAccess(s.leader.id, 'logout', event);
      }
      return A.json(200, { ok: true }, { 'Set-Cookie': A.clearSessionCookie() });
    }

    // ---------- Zustimmung ----------
    if (p.action === 'consent') {
      const s = await A.leaderFromSession(event);
      if (!s) return A.json(401, { error: 'Nicht angemeldet' });
      if (!s.leader.consent_at) {
        await pgrest('leaders', { method: 'PATCH', query: `id=eq.${s.leader.id}`, body: { consent_at: new Date().toISOString() } });
        await A.logAccess(s.leader.id, 'consent', event);
      }
      return A.json(200, { ok: true });
    }

    return A.json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('auth', err.message, err.data || '');
    return A.json(500, { error: 'Anmeldung gerade nicht möglich. Bitte später nochmal.' });
  }
};
