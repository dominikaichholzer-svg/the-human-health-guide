// netlify/functions/admin-reset-login.js
//
// POST { key, leader_id }
//
// "Passwort vergessen": löscht das Passwort einer Leaderin, meldet sie auf
// allen Geräten ab und erzeugt einen neuen Einmal-Link (14 Tage gültig), mit
// dem sie ein neues Passwort wählt. In der Datenbank liegt nur der Hash des
// Links, der Link selbst wird nur dieses eine Mal an den Admin ausgegeben.

const { pgrest } = require('./_lib/supabase');
const A = require('./_lib/auth');

const SITE = process.env.URL || 'https://mein-quiz-health.netlify.app';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return A.json(405, { error: 'Method Not Allowed' });
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return A.json(400, { error: 'Ungültiges JSON' });
  }
  const adminCheck = A.requireAdmin(event, payload);
  if (!adminCheck.ok) return adminCheck.response;

  const leaderId = payload.leader_id;
  if (!leaderId || !/^[0-9a-f-]{36}$/i.test(leaderId)) return A.json(400, { error: 'leader_id fehlt' });

  try {
    const rows = await pgrest('leaders', { query: `id=eq.${leaderId}&select=id,name` });
    if (!rows || !rows[0]) return A.json(404, { error: 'Nicht gefunden' });

    const raw = A.randomToken(24);
    await pgrest('leaders', {
      method: 'PATCH',
      query: `id=eq.${leaderId}`,
      body: {
        password_hash: null,
        password_set_at: new Date().toISOString(), // hält den alten Link dauerhaft ungültig
        setup_token_hash: A.sha256(raw),
        setup_token_expires: new Date(Date.now() + A.SETUP_LINK_DAYS * 86400000).toISOString(),
      },
    });
    await A.revokeSessions(leaderId);
    await A.logAccess(leaderId, 'password_reset_by_admin', event);
    return A.json(200, { ok: true, link: `${SITE}/leader-dashboard.html?setup=${raw}` });
  } catch (err) {
    console.error('admin-reset-login', err.message);
    return A.json(500, { error: 'Zurücksetzen fehlgeschlagen' });
  }
};
