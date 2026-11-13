// netlify/functions/admin-books.js
//
// Freigabe der JARVIS-Bibliothek für die Leaderinnen (nur Admin).
// GET                       -> { books: [{ id, title, kind, team_level }] }
// POST { id, team_level }   -> null | "alle" | "ab_assistant_manager" | "ab_manager"

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');

const LEVELS = [null, 'alle', 'ab_assistant_manager', 'ab_manager'];

exports.handler = async function (event) {
  let p = null;
  if (event.httpMethod === 'POST') {
    try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const adminCheck = await requireAdmin(event, p);
  if (!adminCheck.ok) return adminCheck.response;
  try {
    if (event.httpMethod === 'GET') {
      const rows = await pgrest('agent_books', { query: 'order=id.asc&select=id,title,filename,team_level' });
      return json(200, {
        books: (rows || []).map((b) => ({
          id: b.id, title: b.title, team_level: b.team_level || null,
          kind: String(b.filename || '').startsWith('schulung-video:') ? 'Schulungsvideo' : b.filename === 'web-recherche' ? 'Buch-Notiz' : 'Buch/PDF',
        })),
      });
    }
    const id = Number(p.id);
    const level = p.team_level || null;
    if (!Number.isInteger(id) || !LEVELS.includes(level)) return json(400, { error: 'Ungültige Angabe' });
    await pgrest('agent_books', { method: 'PATCH', query: `id=eq.${id}`, body: { team_level: level } });
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-books', err.message);
    return json(500, { error: 'Bibliothek gerade nicht verfügbar (ist supabase/learning.sql ausgeführt?)' });
  }
};
