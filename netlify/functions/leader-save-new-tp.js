// netlify/functions/leader-save-new-tp.js
//
// POST /.netlify/functions/leader-save-new-tp
// Neu anlegen:  { token, tp_name }
// Schritt toggeln: { token, tp_id, step: "step_3", value: true }
//
// Eine Zeile pro neu gesponserter TP, mit den 7 Onboarding-Schritten als
// Checkboxen.

const { pgrest } = require('./_lib/supabase');

const VALID_STEPS = ['step_1', 'step_2', 'step_3', 'step_4', 'step_5', 'step_6', 'step_7'];

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

  const { token, tp_id, tp_name, step, value } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    if (tp_id) {
      // Schritt toggeln — vorher prüfen, dass die TP wirklich dieser Leaderin gehört
      if (!step || !VALID_STEPS.includes(step)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Ungültiger Schritt' }) };
      }
      const owned = await pgrest('new_tps', { query: `id=eq.${tp_id}&leader_id=eq.${leaderId}&select=id` });
      if (!owned || owned.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
      }
      await pgrest('new_tps', {
        method: 'PATCH',
        query: `id=eq.${tp_id}`,
        body: { [step]: !!value },
      });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    if (!tp_name || !tp_name.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Name fehlt' }) };
    }
    const created = await pgrest('new_tps', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{ leader_id: leaderId, tp_name: tp_name.trim() }],
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, tp: created[0] }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
