// netlify/functions/weekly-coaching-background.js
//
// Hintergrund-Funktion: schreibt das JARVIS-Wochen-Coaching für EINE Leaderin
// und Woche. Angestoßen von ensureCoaching (beim Öffnen des Dashboards, falls
// der Sonntagslauf fehlt). Der Auftrag ist vorher in weekly_coachings
// beansprucht (status pending), das verhindert doppelte Berichte.
// Aufruf nur mit dem internen Geheimnis.

const { pgrest } = require('./_lib/supabase');
const { agentSecret } = require('./_lib/telegram');
const { makeClient } = require('./_lib/agent');
const { generateCoaching } = require('./_lib/weekly-coaching');

exports.handler = async function (event) {
  if ((event.headers || {})['x-agent-secret'] !== agentSecret()) return { statusCode: 403, body: 'Kein Zugriff' };
  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  if (!/^[0-9a-f-]{36}$/i.test(p.leader_id || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.week_start || '')) return { statusCode: 400, body: 'Angaben fehlen' };
  try {
    const leaders = await pgrest('leaders', { query: `id=eq.${p.leader_id}&select=*` });
    if (!leaders || !leaders[0]) throw new Error('Leaderin nicht gefunden');
    const data = await generateCoaching(makeClient(), leaders[0], p.week_start);
    return { statusCode: 200, body: JSON.stringify({ ok: true, created: !!data }) };
  } catch (err) {
    console.error('weekly-coaching', err.message, err.data || '');
    try {
      await pgrest('weekly_coachings', { method: 'PATCH', query: `leader_id=eq.${p.leader_id}&week_start=eq.${p.week_start}&status=eq.pending`, body: { status: 'error' } });
    } catch (e) { /* egal */ }
    return { statusCode: 500, body: 'Fehler' };
  }
};
