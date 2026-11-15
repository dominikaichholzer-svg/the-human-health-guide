// netlify/functions/admin-leader-hold.js
//
// POST { leader_id, on_hold: true|false }  -> Leaderin pausieren oder wieder aktiv setzen.
// Pausiert: bleibt im Admin-Dashboard, fällt aber aus Briefing, Hinweisen und den
// wöchentlichen KI-Auswertungen. Nur Admin.

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const adminCheck = await requireAdmin(event, p);
  if (!adminCheck.ok) return adminCheck.response;
  if (!p.leader_id || !UUID.test(p.leader_id) || typeof p.on_hold !== 'boolean') return json(400, { error: 'Ungültige Anfrage' });
  try {
    await pgrest('leaders', { method: 'PATCH', query: `id=eq.${p.leader_id}`, body: { on_hold: p.on_hold } });
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-leader-hold', err.message);
    return json(500, { error: 'Speichern nicht möglich. Ist supabase/hold.sql ausgeführt?' });
  }
};
