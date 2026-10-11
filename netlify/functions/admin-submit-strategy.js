// netlify/functions/admin-submit-strategy.js
//
// POST /.netlify/functions/admin-submit-strategy
// Body: { "key": "...", "target_month": "2026-11-01", "content": "..." }
//
// Speichert Dominiks Strategie/Monatsplanung für einen Monat. Lässt
// reminder_sent_at bewusst im Payload weg, damit ein Speichern des Texts
// dieses Flag nie zurücksetzt (Idempotenz-Schutz für die Erinnerungsmail).

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

  const { key, target_month, content } = payload;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Kein Zugriff' }) };
  }
  if (!target_month || isNaN(Date.parse(target_month))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'target_month fehlt oder ungültig' }) };
  }

  try {
    await pgrest('monthly_strategy', {
      method: 'POST',
      query: 'on_conflict=target_month',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{ target_month, content: content || '', updated_at: new Date().toISOString() }],
    });
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
