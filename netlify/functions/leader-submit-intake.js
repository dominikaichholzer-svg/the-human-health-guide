// netlify/functions/leader-submit-intake.js
//
// POST /.netlify/functions/leader-submit-intake
// Body: { token, time_capacity, past_follow_through, support_needed }
//
// Einmalige, weich formulierte Selbsteinschätzung zu Beginn (statt einer
// direkten "bist du 18 Monate ALL IN"-Frage). Wird nur einmal abgefragt,
// danach verschwindet die Karte vom Dashboard.

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

  const { token, time_capacity, past_follow_through, support_needed } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    await pgrest('intake_survey', {
      method: 'POST',
      query: 'on_conflict=leader_id',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{
        leader_id: leaderId,
        time_capacity: time_capacity || null,
        past_follow_through: past_follow_through || null,
        support_needed: support_needed || null,
      }],
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
