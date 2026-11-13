// netlify/functions/admin-notes.js
//
// Dominiks eigene Coaching-Notizen zu seinen Leaderinnen. Sieht nur der Admin.
// POST { leader_id, note }   -> Notiz anlegen
// POST { note_id }           -> Notiz löschen

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Ungültiges JSON' });
  }
  const adminCheck = await requireAdmin(event, p);
  if (!adminCheck.ok) return adminCheck.response;

  try {
    if (p.note_id !== undefined) {
      if (!/^\d+$/.test(String(p.note_id))) return json(400, { error: 'id fehlt' });
      await pgrest('coaching_notes', { method: 'DELETE', query: `id=eq.${p.note_id}&author=eq.admin` });
      return json(200, { ok: true });
    }
    if (!p.leader_id || !UUID.test(p.leader_id)) return json(400, { error: 'leader_id fehlt' });
    const note = typeof p.note === 'string' ? p.note.trim().slice(0, 4000) : '';
    if (!note) return json(400, { error: 'Bitte etwas notieren.' });
    await pgrest('coaching_notes', { method: 'POST', body: [{ author: 'admin', leader_id: p.leader_id, member_id: null, note }] });
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-notes', err.message, err.data || '');
    return json(500, { error: 'Notiz konnte nicht gespeichert werden.' });
  }
};
