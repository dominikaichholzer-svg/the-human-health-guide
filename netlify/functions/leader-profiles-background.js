// netlify/functions/leader-profiles-background.js
//
// Hintergrund-Funktion (bis 15 Minuten Laufzeit): JARVIS aktualisiert die
// Entwicklungsprofile. Body: { leader_id? }  ohne leader_id = alle Leaderinnen.
// Mit { mode: "devplans", leader_id?, force? } stattdessen die Entwicklungspläne:
// Vorschlag und Monatsauswertung, nur wo fällig (force = Vorschlag neu erstellen).
// Mit { mode: "insights", leader_id?, force? } nur die Erkenntnis der Woche ("JARVIS ist aufgefallen").
// Ohne mode: Profile und danach die Erkenntnisse der kommenden Woche.
// Ohne leader_id (Sonntagslauf) vorher das Wochen-Coaching (_lib/weekly-coaching.js).
// Mit { mode: "coaching" } nur das Wochen-Coaching.
// Aufruf nur mit dem internen Geheimnis (x-agent-secret), von
// scheduled-leader-profiles.js (Sonntag 20:00) oder admin-profile-refresh.js.

const { pgrest } = require('./_lib/supabase');
const { agentSecret } = require('./_lib/telegram');
const { makeClient } = require('./_lib/agent');
const { updateProfile } = require('./_lib/profile');
const { runDevplans } = require('./_lib/devplan');
const { runInsights } = require('./_lib/insights');
const { targetWeek, hasDays, claim, generateCoaching } = require('./_lib/weekly-coaching');
const { sendPush } = require('./_lib/webpush');
const { dashboardUrl } = require('./_lib/pushlinks');

// Push: das Wochen-Coaching ist da
async function notifyCoaching(leader) {
  let subs = [];
  try { subs = (await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` })) || []; } catch (e) { return; }
  for (const sub of subs) {
    try {
      await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, {
        title: 'Dein Wochen-Coaching ist da ✨',
        body: 'JARVIS hat auf deine Woche geschaut. Was du mitnehmen kannst, steht im Überblick.',
        url: dashboardUrl(leader, 'overview'),
      });
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        try { await pgrest('push_subscriptions', { method: 'DELETE', query: `id=eq.${sub.id}` }); } catch (e) { /* egal */ }
      }
    }
  }
}

exports.handler = async function (event) {
  if ((event.headers || {})['x-agent-secret'] !== agentSecret()) return { statusCode: 403, body: 'Kein Zugriff' };
  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const q = p.leader_id && /^[0-9a-f-]{36}$/i.test(p.leader_id) ? `id=eq.${p.leader_id}&select=*` : 'select=*&order=sort_order.asc';
  // Pausierte Leaderinnen nur, wenn Dominik sie ausdrücklich anstößt (leader_id)
  const leaders = ((await pgrest('leaders', { query: q })) || []).filter((l) => p.leader_id || !l.on_hold);
  const client = makeClient();
  if (p.mode === 'devplans') {
    const results = await runDevplans(client, leaders, undefined, { force: !!p.force });
    return { statusCode: 200, body: JSON.stringify({ results }) };
  }
  if (p.mode === 'insights') {
    const results = await runInsights(client, leaders, undefined, { force: !!p.force });
    return { statusCode: 200, body: JSON.stringify({ results }) };
  }
  // Sonntagslauf (ohne leader_id): zuerst das Wochen-Coaching aus den
  // Tagesabschlüssen, damit das Profil danach schon darauf aufbauen kann.
  const coachings = [];
  if (!p.leader_id || p.mode === 'coaching') {
    const week = targetWeek();
    for (const leader of leaders) {
      try {
        if (!(await hasDays(leader.id, week))) { coachings.push({ leader: leader.name, skipped: 'keine Tagesabschlüsse' }); continue; }
        if (!(await claim(leader.id, week))) { coachings.push({ leader: leader.name, skipped: 'schon vorhanden' }); continue; }
        const data = await generateCoaching(client, leader, week);
        if (data) await notifyCoaching(leader);
        coachings.push({ leader: leader.name, ok: !!data });
      } catch (err) {
        console.error('Wochen-Coaching', leader.name, err.message);
        try { await pgrest('weekly_coachings', { method: 'PATCH', query: `leader_id=eq.${leader.id}&week_start=eq.${week}&status=eq.pending`, body: { status: 'error' } }); } catch (e) { /* egal */ }
        coachings.push({ leader: leader.name, ok: false, error: err.message });
      }
    }
    if (p.mode === 'coaching') return { statusCode: 200, body: JSON.stringify({ coachings }) };
  }

  const results = [];
  for (const leader of leaders) {
    try {
      await updateProfile(client, leader);
      results.push({ leader: leader.name, ok: true });
    } catch (err) {
      console.error('Profil', leader.name, err.message);
      results.push({ leader: leader.name, ok: false, error: err.message });
    }
  }
  // Danach die Erkenntnis der kommenden Woche (höchstens eine je Leaderin)
  let insights = [];
  try { insights = await runInsights(client, leaders); } catch (err) { console.error('Erkenntnisse', err.message); }
  return { statusCode: 200, body: JSON.stringify({ coachings, results, insights }) };
};
