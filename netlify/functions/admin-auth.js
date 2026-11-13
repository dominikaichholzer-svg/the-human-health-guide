// netlify/functions/admin-auth.js
//
// Admin-Anmeldung: Benutzername + Passwort, danach 6-stelliger Code per E-Mail.
//
// GET  ?action=me                                  -> { ready, loggedIn, accountExists }
// POST { action:"setup", key, username, password }  -> erstes Einrichten (nur mit altem Schlüssel
//                                                     und nur solange kein Konto existiert), schickt Code
// POST { action:"login", username, password }       -> schickt Code
// POST { action:"verify", challenge, code }         -> Code prüfen, Sitzung (Cookie) setzen
// POST { action:"logout" }

const crypto = require('crypto');
const { pgrest } = require('./_lib/supabase');
const A = require('./_lib/auth');
const { adminEmail, sendMail, maskEmail } = require('./_lib/notify');

const CODE_MINUTES = 10;
const MAX_CODE_TRIES = 5;

let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = A.hashPassword('nicht-das-passwort-' + A.randomToken(8));
  return dummyHashPromise;
}
const normUser = (u) => String(u || '').trim().toLowerCase().slice(0, 60);
const codeHash = (challenge, code) => A.sha256('admin-code:' + challenge + ':' + code);

// Erzeugt Code + Challenge, speichert nur Hashes, schickt die Mail.
async function startChallenge(pending) {
  const challenge = A.randomToken(24);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pgrest('admin_login_codes', {
    method: 'POST',
    body: [{
      challenge_hash: A.sha256(challenge),
      code_hash: codeHash(challenge, code),
      expires_at: new Date(Date.now() + CODE_MINUTES * 60000).toISOString(),
      pending_username: pending ? pending.username : null,
      pending_password_hash: pending ? pending.passwordHash : null,
    }],
  });
  const to = adminEmail();
  await sendMail(
    to,
    `Dein Admin-Code: ${code}`,
    `<p>Dein Code für das Admin-Dashboard:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;">${code}</p><p>Er gilt ${CODE_MINUTES} Minuten. Wenn du dich gerade nicht anmeldest, ignoriere diese Mail und ändere am besten dein Passwort.</p>`
  );
  return { challenge, sentTo: maskEmail(to) };
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      if (!event.queryStringParameters || event.queryStringParameters.action !== 'me') {
        return A.json(400, { error: 'Unbekannte Aktion' });
      }
      let account;
      try {
        account = await A.getAdminAccount();
      } catch (e) {
        return A.json(200, { ready: false }); // Tabellen fehlen noch
      }
      const s = await A.adminFromSession(event);
      return A.json(200, { ready: true, loggedIn: !!s, accountExists: !!account });
    }

    if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method Not Allowed' });
    let p;
    try {
      p = JSON.parse(event.body || '{}');
    } catch (e) {
      return A.json(400, { error: 'Ungültiges JSON' });
    }

    // ---------- erstes Einrichten ----------
    if (p.action === 'setup') {
      if (await A.isLocked(event)) return A.json(429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      if (await A.getAdminAccount()) return A.json(409, { error: 'Das Admin-Konto ist schon eingerichtet. Bitte normal anmelden.' });
      if (!A.keyMatches(event, p)) {
        await A.recordFail(event);
        return A.json(403, { error: 'Kein Zugriff' });
      }
      const username = normUser(p.username);
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) return A.json(400, { error: 'Benutzername: 3 bis 40 Zeichen, nur Buchstaben, Zahlen, Punkt, Strich.' });
      if (typeof p.password !== 'string' || p.password.length < 10) return A.json(400, { error: 'Das Admin-Passwort braucht mindestens 10 Zeichen.' });
      if (p.password.length > 200) return A.json(400, { error: 'Das Passwort ist zu lang.' });
      const out = await startChallenge({ username, passwordHash: await A.hashPassword(p.password) });
      await A.logAccess(null, 'admin_setup_code_sent', event);
      return A.json(200, out);
    }

    // ---------- Anmelden: Schritt 1 ----------
    if (p.action === 'login') {
      const username = normUser(p.username);
      if (!username || typeof p.password !== 'string' || !p.password) return A.json(400, { error: 'Bitte Benutzername und Passwort eingeben.' });
      const lockKey = 'admin:' + username;
      if (await A.isLocked(event, lockKey)) return A.json(429, { error: 'Zu viele falsche Versuche. Bitte in 15 Minuten nochmal.' });
      const acc = await A.getAdminAccount();
      const ok = await A.verifyPassword(p.password, (acc && acc.password_hash) || (await dummyHash()));
      if (!acc || acc.username !== username || !ok) {
        await A.recordFail(event, lockKey);
        await A.logAccess(null, 'admin_login_failed', event, username);
        return A.json(401, { error: 'Benutzername oder Passwort stimmt nicht.' });
      }
      const out = await startChallenge(null);
      await A.logAccess(null, 'admin_code_sent', event);
      return A.json(200, out);
    }

    // ---------- Anmelden: Schritt 2 (Code) ----------
    if (p.action === 'verify') {
      if (await A.isLocked(event)) return A.json(429, { error: 'Zu viele Versuche. Bitte in 15 Minuten nochmal.' });
      const challenge = String(p.challenge || '');
      const code = String(p.code || '').replace(/\s/g, '');
      if (!/^[0-9a-f]{48}$/.test(challenge) || !/^\d{6}$/.test(code)) return A.json(400, { error: 'Bitte den 6-stelligen Code eingeben.' });
      const rows = await pgrest('admin_login_codes', { query: `challenge_hash=eq.${A.sha256(challenge)}&select=*` });
      const c = rows && rows[0];
      if (c) c.attempts = Number(c.attempts) || 0;
      if (!c || c.used_at || new Date(c.expires_at).getTime() < Date.now() || c.attempts >= MAX_CODE_TRIES) {
        return A.json(410, { error: 'Der Code ist abgelaufen. Bitte melde dich nochmal an.' });
      }
      const good = c.code_hash.length === 64 && crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(codeHash(challenge, code)));
      if (!good) {
        await pgrest('admin_login_codes', { method: 'PATCH', query: `id=eq.${c.id}`, body: { attempts: c.attempts + 1 } });
        await A.recordFail(event);
        const left = MAX_CODE_TRIES - c.attempts - 1;
        return A.json(401, { error: left > 0 ? `Code stimmt nicht. Noch ${left} Versuche.` : 'Code stimmt nicht. Bitte melde dich nochmal an.' });
      }
      await pgrest('admin_login_codes', {
        method: 'PATCH',
        query: `id=eq.${c.id}`,
        body: { used_at: new Date().toISOString(), pending_password_hash: null },
      });
      if (c.pending_password_hash) {
        // Erstes Einrichten: Konto erst jetzt anlegen (ab dann gilt der alte Schlüssel nicht mehr)
        if (await A.getAdminAccount()) return A.json(409, { error: 'Das Admin-Konto ist schon eingerichtet. Bitte normal anmelden.' });
        await pgrest('admin_account', {
          method: 'POST',
          body: [{ id: 1, username: c.pending_username, password_hash: c.pending_password_hash, password_set_at: new Date().toISOString() }],
        });
        await A.logAccess(null, 'admin_account_created', event);
      }
      const raw = await A.createAdminSession(event);
      await A.logAccess(null, 'admin_login', event);
      return A.json(200, { ok: true }, { 'Set-Cookie': A.adminCookie(raw) });
    }

    // ---------- Abmelden ----------
    if (p.action === 'logout') {
      const s = await A.adminFromSession(event);
      if (s) await pgrest('admin_sessions', { method: 'PATCH', query: `id=eq.${s.id}`, body: { revoked_at: new Date().toISOString() } });
      return A.json(200, { ok: true }, { 'Set-Cookie': A.clearAdminCookie() });
    }

    return A.json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('admin-auth', err.message, err.data || '');
    const mail = /Resend|RESEND/.test(err.message);
    return A.json(500, { error: mail ? 'Die E-Mail mit dem Code konnte nicht verschickt werden.' : 'Anmeldung gerade nicht möglich.' });
  }
};
