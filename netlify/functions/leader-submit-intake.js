// netlify/functions/leader-submit-intake.js
//
// POST /.netlify/functions/leader-submit-intake
// Body: { token, fokus_produkte: [...], lieblingsbereich, time_capacity,
//         past_follow_through, warum, support_needed }
//
// Einmalige, weich formulierte Selbsteinschätzung zu Beginn (statt einer
// direkten "bist du 18 Monate ALL IN"-Frage). Wird nur einmal abgefragt,
// danach erscheint das Popup nicht mehr. Die gewählten Fokus-Produkte
// werden zusätzlich als specialized_products der Leaderin gespeichert
// (Dominik kann sie im Admin-Dashboard jederzeit ändern).

const { pgrest } = require('./_lib/supabase');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ungültiger Request-Body' }) };
  }

  const { token, time_capacity, past_follow_through, support_needed, lieblingsbereich, warum } = payload;
  const fokus = Array.isArray(payload.fokus_produkte) ? payload.fokus_produkte.slice(0, 5).map(String) : [];
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    const row = {
      leader_id: leaderId,
      time_capacity: time_capacity || null,
      past_follow_through: past_follow_through || null,
      support_needed: support_needed || null,
      fokus_produkte: fokus.length ? fokus.join(', ') : null,
      lieblingsbereich: lieblingsbereich || null,
      warum: warum || null,
    };
    const save = (body) =>
      pgrest('intake_survey', {
        method: 'POST',
        query: 'on_conflict=leader_id',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: [body],
      });
    try {
      await save(row);
    } catch (err) {
      // Solange die neuen Spalten in Supabase fehlen (PGRST204), die
      // Grundantworten trotzdem speichern
      if (!(err.data && err.data.code === 'PGRST204')) throw err;
      const { fokus_produkte, lieblingsbereich: _l, warum: _w, ...rest } = row;
      await save(rest);
    }

    if (fokus.length) {
      await pgrest('leaders', {
        method: 'PATCH',
        query: `id=eq.${leaderId}`,
        body: { specialized_products: fokus.join(', ') },
      });
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
