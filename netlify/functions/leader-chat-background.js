// netlify/functions/leader-chat-background.js
//
// Hintergrund-Funktion (bis 15 Minuten): beantwortet einen Chat-Auftrag aus
// chat_jobs mit JARVIS als Lernbegleiter (Schulungen nachschlagen, Lernnotizen
// speichern). Aufruf nur mit dem internen Geheimnis aus leader-chat.js.
// Aufträge vom Typ "focus" (aus leader-focus.js): Coaching-Schwerpunkt für eine
// Partnerin, reply ist dann JSON.

const { pgrest } = require('./_lib/supabase');
const { agentSecret } = require('./_lib/telegram');
const { makeClient } = require('./_lib/agent');
const { answer } = require('./_lib/leader-chat-core');
const { focusFor } = require('./_lib/support');

exports.handler = async function (event) {
  if ((event.headers || {})['x-agent-secret'] !== agentSecret()) return { statusCode: 403, body: 'Kein Zugriff' };
  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch (e) { p = {}; }
  const jobs = await pgrest('chat_jobs', { query: `id=eq.${encodeURIComponent(p.job_id || '')}&status=eq.pending&select=*` });
  const job = jobs && jobs[0];
  if (!job) return { statusCode: 404, body: 'Kein offener Auftrag' };
  try {
    const leaders = await pgrest('leaders', { query: `id=eq.${job.leader_id}&select=*` });
    const leader = leaders && leaders[0];
    if (!leader) throw new Error('Leaderin nicht gefunden');
    const text = job.request && job.request.type === 'focus'
      ? JSON.stringify(await focusFor(makeClient(), leader, job.request.member_id))
      : await answer(makeClient(), leader, job.request.message, job.request.history, { tools: true });
    await pgrest('chat_jobs', { method: 'PATCH', query: `id=eq.${job.id}`, body: { status: 'done', reply: text, finished_at: new Date().toISOString() } });
    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('leader-chat-background', err.message);
    await pgrest('chat_jobs', { method: 'PATCH', query: `id=eq.${job.id}`, body: { status: 'error', finished_at: new Date().toISOString() } });
    return { statusCode: 500, body: 'Fehler' };
  }
};
