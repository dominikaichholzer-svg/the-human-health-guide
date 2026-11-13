// netlify/functions/admin-profile-refresh.js
//
// POST { leader_id }  -> JARVIS analysiert diese Leaderin jetzt neu (im Hintergrund,
// dauert etwa eine halbe Minute). Nur Admin.

const { requireAdmin, json } = require('./_lib/auth');
const { agentSecret } = require('./_lib/telegram');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const adminCheck = await requireAdmin(event, p);
  if (!adminCheck.ok) return adminCheck.response;
  if (!p.leader_id || !/^[0-9a-f-]{36}$/i.test(p.leader_id)) return json(400, { error: 'leader_id fehlt' });
  try {
    await fetch(`${process.env.URL}/.netlify/functions/leader-profiles-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
      body: JSON.stringify({ leader_id: p.leader_id }),
    });
    return json(202, { ok: true });
  } catch (err) {
    return json(500, { error: 'Analyse konnte nicht gestartet werden.' });
  }
};
