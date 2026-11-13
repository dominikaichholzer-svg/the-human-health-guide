// netlify/functions/leader-chat-poll.js
//
// GET ?id=<jobId>  -> { status: "pending" | "done" | "error", reply? }
// Nur für die eigene Leaderin (leader_id im Filter).

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  const auth = await requireLeader(event, null);
  if (!auth.ok) return auth.response;
  const id = (event.queryStringParameters || {}).id;
  if (!id || !UUID.test(id)) return json(400, { error: 'id fehlt' });
  try {
    const rows = await pgrest('chat_jobs', { query: `id=eq.${id}&leader_id=eq.${auth.leader.id}&select=status,reply` });
    const job = rows && rows[0];
    if (!job) return json(404, { error: 'Nicht gefunden' });
    return json(200, { status: job.status, reply: job.status === 'done' ? job.reply : undefined });
  } catch (err) {
    return json(500, { error: 'Gerade nicht verfügbar' });
  }
};
