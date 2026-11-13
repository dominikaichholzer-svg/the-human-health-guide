// netlify/functions/leader-profiles-background.js
//
// Hintergrund-Funktion (bis 15 Minuten Laufzeit): JARVIS aktualisiert die
// Entwicklungsprofile. Body: { leader_id? }  ohne leader_id = alle Leaderinnen.
// Aufruf nur mit dem internen Geheimnis (x-agent-secret), von
// scheduled-leader-profiles.js (Sonntag 20:00) oder admin-profile-refresh.js.

const { pgrest } = require('./_lib/supabase');
const { agentSecret } = require('./_lib/telegram');
const { makeClient } = require('./_lib/agent');
const { updateProfile } = require('./_lib/profile');

exports.handler = async function (event) {
  if ((event.headers || {})['x-agent-secret'] !== agentSecret()) return { statusCode: 403, body: 'Kein Zugriff' };
  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const q = p.leader_id && /^[0-9a-f-]{36}$/i.test(p.leader_id) ? `id=eq.${p.leader_id}&select=*` : 'select=*&order=sort_order.asc';
  const leaders = (await pgrest('leaders', { query: q })) || [];
  const client = makeClient();
  const results = [];
  for (const leader of leaders) {
    try {
      await updateProfile(client, leader);
      results.push({ leader: leader.name, ok: true });
    } catch (err) {
      console.error('Profil', leader.name, err.message);
      results.push({ leader: leader.name, ok: false, error: err.message });
    }
  }
  return { statusCode: 200, body: JSON.stringify({ results }) };
};
