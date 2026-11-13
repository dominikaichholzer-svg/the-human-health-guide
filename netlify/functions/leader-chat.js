// netlify/functions/leader-chat.js
//
// POST /.netlify/functions/leader-chat
// Body: { message, history }                       normale Frage
//       { prepare_member_id, history }             Coaching-Gespräch mit einer eigenen Partnerin vorbereiten
//       { ask: "plan", history }                   Ideen, wenn sie hinter dem Monatsplan liegt (aus der Push-Warnung)
//   history: letzte Nachrichten dieser Sitzung (nicht gespeichert)
//
// Ab Schritt 2 (Lernbegleiter) entsteht die Antwort im Hintergrund, weil
// JARVIS dafür in Schulungen nachschlagen kann (länger als 10 Sekunden):
//   Antwort: { jobId, shownMessage }  -> die Seite fragt leader-chat-poll ab
// Fehlt die Tabelle chat_jobs noch, antwortet er wie bisher direkt, ohne Werkzeuge:
//   Antwort: { reply, shownMessage }

const { pgrest } = require('./_lib/supabase');
const { requireLeader } = require('./_lib/auth');
const { makeClient } = require('./_lib/agent');
const { agentSecret } = require('./_lib/telegram');
const { resolveMessage, answer } = require('./_lib/leader-chat-core');

const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return reply(400, { error: 'Ungültiger Request-Body' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return reply(503, { error: 'Chat ist aktuell nicht verfügbar.' });

  try {
    const auth = await requireLeader(event, payload);
    if (!auth.ok) return auth.response;
    const leader = auth.leader;
    const r = await resolveMessage(leader, payload);
    if (r.error) return reply(r.status, { error: r.error });

    // Im Hintergrund mit Werkzeugen beantworten
    let job = null;
    try {
      const rows = await pgrest('chat_jobs', {
        method: 'POST',
        prefer: 'return=representation',
        body: [{ leader_id: leader.id, status: 'pending', request: { message: r.message, history: Array.isArray(payload.history) ? payload.history.slice(-10) : [] }, shown_message: r.message }],
      });
      job = rows && rows[0];
    } catch (e) { job = null; }
    if (job) {
      await fetch(`${process.env.URL}/.netlify/functions/leader-chat-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
        body: JSON.stringify({ job_id: job.id }),
      });
      return reply(202, { jobId: job.id, shownMessage: r.message });
    }

    // Fallback: direkt, ohne Werkzeuge
    const text = await answer(makeClient(), leader, r.message, payload.history, { tools: false });
    return reply(200, { reply: text, shownMessage: r.message });
  } catch (err) {
    return reply(500, { error: 'Serverfehler', detail: err.message });
  }
};
