// netlify/functions/admin-devplan.js
//
// Entwicklungsplan, Admin-Seite.
// POST { leader_id, month, feedback }   -> Dominiks Feedback / Coaching-Schwerpunkt zum Plan
// POST { leader_id, regenerate: true }  -> JARVIS macht einen neuen Vorschlag (nur solange
//                                          er noch nicht bestätigt ist), im Hintergrund

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');
const { agentSecret } = require('./_lib/telegram');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const adminCheck = await requireAdmin(event, p);
  if (!adminCheck.ok) return adminCheck.response;
  if (!p.leader_id || !UUID.test(p.leader_id)) return json(400, { error: 'leader_id fehlt' });

  try {
    if (p.regenerate) {
      await fetch(`${process.env.URL}/.netlify/functions/leader-profiles-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
        body: JSON.stringify({ mode: 'devplans', leader_id: p.leader_id, force: true }),
      });
      return json(202, { ok: true });
    }
    if (!/^\d{4}-\d{2}$/.test(String(p.month || ''))) return json(400, { error: 'Monat fehlt' });
    const feedback = typeof p.feedback === 'string' && p.feedback.trim() ? p.feedback.trim().slice(0, 2000) : null;
    const rows = await pgrest('development_plans', { query: `leader_id=eq.${p.leader_id}&month=eq.${p.month}-01&select=id` });
    if (!rows || !rows[0]) return json(404, { error: 'Kein Plan für diesen Monat' });
    await pgrest('development_plans', { method: 'PATCH', query: `id=eq.${rows[0].id}`, body: { coach_feedback: feedback, updated_at: new Date().toISOString() } });
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-devplan', err.message);
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
