// netlify/functions/leader-challenge.js
//
// POST { week_no, task_done?, answer? }
// Die angemeldete Leaderin hakt die Wochenaufgabe ab und/oder beantwortet die
// Reflexionsfrage. Erlaubt: laufende Woche und die Vorwoche (zum Nachholen).

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { weekNoFor, WEEKS } = require('./_lib/challenge');
const { viennaTodayStr } = require('./_lib/ranks');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try {
    p = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Ungültiges JSON' });
  }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;

  const current = weekNoFor(viennaTodayStr());
  const weekNo = Number(p.week_no);
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > WEEKS || (weekNo !== current && weekNo !== current - 1)) {
    return json(400, { error: 'Diese Woche kann nicht mehr geändert werden.' });
  }
  const row = { leader_id: auth.leader.id, week_no: weekNo, updated_at: new Date().toISOString() };
  if (p.task_done !== undefined) row.task_done = !!p.task_done;
  if (p.answer !== undefined) {
    const a = typeof p.answer === 'string' ? p.answer.trim().slice(0, 4000) : '';
    row.answer = a || null;
  }
  if (row.task_done === undefined && row.answer === undefined) return json(400, { error: 'Nichts zu speichern' });

  try {
    await pgrest('challenge_progress', {
      method: 'POST',
      query: 'on_conflict=leader_id,week_no',
      prefer: 'resolution=merge-duplicates',
      body: [row],
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('leader-challenge', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
