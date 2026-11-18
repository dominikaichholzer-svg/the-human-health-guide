// netlify/functions/leader-incentive.js
//
// POST { incentive_id, period: 'main'|'bonus', new_cc, new_as, new_s }
// Die angemeldete Leaderin trägt ihren Incentive-Stand aus FLP360 ein.
// Leeres Feld = wieder automatisch aus Mein Team rechnen.

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function val(v, int) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100000) return undefined;
  return int ? Math.round(n) : Math.round(n * 1000) / 1000;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;

  if (!UUID.test(p.incentive_id || '')) return json(400, { error: 'Incentive fehlt' });
  const period = p.period === 'bonus' ? 'bonus' : 'main';
  const row = {
    incentive_id: p.incentive_id,
    leader_id: auth.leader.id,
    period,
    new_cc: val(p.new_cc, false),
    new_as: val(p.new_as, true),
    new_s: val(p.new_s, true),
    updated_at: new Date().toISOString(),
  };
  if ([row.new_cc, row.new_as, row.new_s].includes(undefined)) return json(400, { error: 'Bitte nur Zahlen eintragen.' });

  try {
    const inc = await pgrest('incentives', { query: `id=eq.${row.incentive_id}&active=is.true&select=id` });
    if (!inc || !inc[0]) return json(404, { error: 'Incentive nicht gefunden' });
    await pgrest('incentive_entries', {
      method: 'POST',
      query: 'on_conflict=incentive_id,leader_id,period',
      prefer: 'resolution=merge-duplicates',
      body: [row],
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('leader-incentive', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich. Ist das neue SQL ausgeführt?' });
  }
};
