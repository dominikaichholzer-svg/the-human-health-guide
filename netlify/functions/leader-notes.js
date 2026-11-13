// netlify/functions/leader-notes.js
//
// Lernnotizen und Aufgaben der angemeldeten Leaderin.
// GET                                   -> { notes: [...] } neueste zuerst
// POST { action:"add", kind, text }      -> kind "note" | "task"
// POST { action:"toggle", id, done }     -> Aufgabe abhaken
// POST { action:"delete", id }

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');

exports.handler = async function (event) {
  let p = null;
  if (event.httpMethod === 'POST') {
    try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;
  const lid = auth.leader.id;
  try {
    if (event.httpMethod === 'GET') {
      const rows = await pgrest('learning_notes', { query: `leader_id=eq.${lid}&order=created_at.desc&limit=100&select=id,kind,text,done,source,created_at` });
      return json(200, { notes: rows || [] });
    }
    if (p.action === 'add') {
      const text = typeof p.text === 'string' ? p.text.trim().slice(0, 2000) : '';
      if (!text) return json(400, { error: 'Text fehlt' });
      await pgrest('learning_notes', { method: 'POST', body: [{ leader_id: lid, kind: p.kind === 'task' ? 'task' : 'note', text, source: p.source === 'chat' ? 'chat' : 'manuell' }] });
      return json(200, { ok: true });
    }
    const id = String(p.id || '');
    if (!/^\d+$/.test(id)) return json(400, { error: 'id fehlt' });
    if (p.action === 'toggle') {
      await pgrest('learning_notes', { method: 'PATCH', query: `id=eq.${id}&leader_id=eq.${lid}`, body: { done: !!p.done } });
      return json(200, { ok: true });
    }
    if (p.action === 'delete') {
      await pgrest('learning_notes', { method: 'DELETE', query: `id=eq.${id}&leader_id=eq.${lid}` });
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('leader-notes', err.message);
    return json(500, { error: 'Gerade nicht möglich.' });
  }
};
