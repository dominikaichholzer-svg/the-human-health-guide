// netlify/functions/leader-focus.js
//
// POST { member_id }  -> JARVIS schlägt für eine EIGENE Partnerin einen Coaching-Schwerpunkt vor.
// Läuft wie der Chat im Hintergrund (chat_jobs, Typ "focus"), Antwort: { jobId }.
// Die Seite holt das Ergebnis mit leader-chat-poll ab (reply = JSON des Vorschlags).
// Übernehmen passiert danach über leader-team (save-goal / add-note), also erst,
// wenn die Leaderin es bestätigt.

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { agentSecret } = require('./_lib/telegram');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let p;
  try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'JARVIS ist gerade nicht verfügbar.' });
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;
  if (!p.member_id || !UUID.test(String(p.member_id))) return json(400, { error: 'Partnerin fehlt' });
  try {
    const own = await pgrest('team_members', { query: `id=eq.${p.member_id}&leader_id=eq.${auth.leader.id}&select=id,name` });
    if (!own || !own[0]) return json(404, { error: 'Nicht gefunden' });
    const rows = await pgrest('chat_jobs', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{ leader_id: auth.leader.id, status: 'pending', request: { type: 'focus', member_id: own[0].id }, shown_message: `Coaching-Schwerpunkt für ${own[0].name}` }],
    });
    const job = rows && rows[0];
    if (!job) throw new Error('Auftrag nicht angelegt');
    await fetch(`${process.env.URL}/.netlify/functions/leader-chat-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
      body: JSON.stringify({ job_id: job.id }),
    });
    return json(202, { jobId: job.id });
  } catch (err) {
    console.error('leader-focus', err.message);
    return json(500, { error: 'JARVIS ist gerade nicht erreichbar.' });
  }
};
