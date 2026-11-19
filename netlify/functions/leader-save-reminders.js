// netlify/functions/leader-save-reminders.js
//
// POST { daily_time: "19:00", weekly_time: "18:30" }
// Die angemeldete Leaderin wählt, wann sie erinnert wird (Viertelstunden, 06:00 bis 23:45).

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');

const TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const okTime = (t) => TIME.test(t || '') && t >= '06:00';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;
  if (!okTime(p.daily_time) || !okTime(p.weekly_time)) return json(400, { error: 'Bitte eine Uhrzeit auswählen.' });
  try {
    await pgrest('leaders', {
      method: 'PATCH',
      query: `id=eq.${auth.leader.id}`,
      body: { reminder_daily_time: p.daily_time, reminder_weekly_time: p.weekly_time, reminder_set_at: new Date().toISOString() },
    });
    return json(200, { ok: true });
  } catch (err) {
    console.error('leader-save-reminders', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
