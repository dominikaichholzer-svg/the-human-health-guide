// netlify/functions/admin-challenge.js
//
// Admin-Editor der 52-Wochen-Challenge.
// GET                                          -> alle 52 Wochen mit Inhalt, Startdatum,
//                                                  Anzahl erledigter Aufgaben und Antworten,
//                                                  dazu die Antworten aller Leaderinnen
// POST { week_no, impuls, aufgabe, frage }     -> Woche speichern

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');
const { START, WEEKS, weekNoFor, weekStartOf } = require('./_lib/challenge');
const { viennaTodayStr } = require('./_lib/ranks');

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 4000) : null);

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Ungültiges JSON' });
    }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const adminCheck = await requireAdmin(event, payload);
  if (!adminCheck.ok) return adminCheck.response;

  try {
    if (event.httpMethod === 'GET') {
      const [content, progress, leaders] = await Promise.all([
        pgrest('challenge_weeks', { query: 'select=week_no,impuls,aufgabe,frage,updated_at' }),
        pgrest('challenge_progress', { query: 'select=leader_id,week_no,task_done,answer,updated_at' }),
        pgrest('leaders', { query: 'select=id,name&order=sort_order.asc' }),
      ]);
      const byWeek = Object.fromEntries((content || []).map((r) => [r.week_no, r]));
      const nameOf = Object.fromEntries((leaders || []).map((l) => [l.id, l.name]));
      const weeks = [];
      for (let n = 1; n <= WEEKS; n++) {
        const rows = (progress || []).filter((r) => r.week_no === n);
        const c = byWeek[n] || {};
        weeks.push({
          weekNo: n,
          weekStart: weekStartOf(n),
          impuls: c.impuls || '',
          aufgabe: c.aufgabe || '',
          frage: c.frage || '',
          doneCount: rows.filter((r) => r.task_done).length,
          answers: rows.filter((r) => r.answer).map((r) => ({ name: nameOf[r.leader_id] || '?', answer: r.answer, taskDone: r.task_done })),
        });
      }
      return json(200, { startDate: START, currentWeek: weekNoFor(viennaTodayStr()), leaderCount: (leaders || []).length, weeks });
    }

    const n = Number(payload.week_no);
    if (!Number.isInteger(n) || n < 1 || n > WEEKS) return json(400, { error: 'Ungültige Woche' });
    await pgrest('challenge_weeks', {
      method: 'POST',
      query: 'on_conflict=week_no',
      prefer: 'resolution=merge-duplicates',
      body: [{ week_no: n, impuls: clean(payload.impuls), aufgabe: clean(payload.aufgabe), frage: clean(payload.frage), updated_at: new Date().toISOString() }],
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-challenge', err.message, err.data || '');
    return json(500, { error: 'Challenge gerade nicht verfügbar.' });
  }
};
