// netlify/functions/leader-coaching.js
//
// JARVIS-Wochen-Coaching der angemeldeten Leaderin.
// GET                       -> { week, status, list }  (zum Nachladen, solange es entsteht)
// POST { seen: "YYYY-MM-DD" } -> Coaching dieser Woche als gelesen markieren

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { viennaTodayStr } = require('./_lib/ranks');
const { ensureCoaching, listCoachings } = require('./_lib/weekly-coaching');

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const auth = await requireLeader(event, payload);
  if (!auth.ok) return auth.response;
  try {
    if (event.httpMethod === 'POST') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.seen || '')) return json(400, { error: 'Woche fehlt' });
      await pgrest('weekly_coachings', { method: 'PATCH', query: `leader_id=eq.${auth.leader.id}&week_start=eq.${payload.seen}&seen_at=is.null`, body: { seen_at: new Date().toISOString() } });
      return json(200, { ok: true });
    }
    const st = await ensureCoaching(auth.leader, viennaTodayStr());
    return json(200, { week: st.week, status: st.status, list: await listCoachings(auth.leader.id, 12) });
  } catch (err) {
    console.error('leader-coaching', err.message);
    return json(500, { error: 'Gerade nicht verfügbar' });
  }
};
