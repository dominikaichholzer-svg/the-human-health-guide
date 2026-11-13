// netlify/functions/leader-insight.js
//
// "JARVIS ist aufgefallen …" aus Sicht der angemeldeten Leaderin.
// POST { id, action: "done" | "later" }  -> Erledigt / Nicht jetzt (blendet die Karte aus)

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;
  const id = Number(p.id);
  const status = { done: 'erledigt', later: 'spaeter' }[p.action];
  if (!Number.isInteger(id) || id <= 0 || !status) return json(400, { error: 'Ungültige Anfrage' });
  try {
    const rows = await pgrest('jarvis_insights', {
      method: 'PATCH',
      query: `id=eq.${id}&leader_id=eq.${auth.leader.id}`,
      prefer: 'return=representation',
      body: { status, updated_at: new Date().toISOString() },
    });
    if (!rows || !rows.length) return json(404, { error: 'Nicht gefunden' });
    return json(200, { ok: true });
  } catch (err) {
    console.error('leader-insight', err.message);
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
