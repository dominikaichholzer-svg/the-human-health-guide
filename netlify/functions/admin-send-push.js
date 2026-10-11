// netlify/functions/admin-send-push.js
//
// POST /.netlify/functions/admin-send-push
// Body: { key, leader_id, title, body }   // leader_id === "all" -> an alle 5
//
// Manuelles Senden einer Push-Benachrichtigung durch Dominik. Abgelaufene
// Subscriptions (Browser hat die Benachrichtigung deaktiviert, 404/410 vom
// Push-Dienst) werden automatisch aus der Datenbank entfernt.

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');

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

  const { key, leader_id, title, body } = payload;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Kein Zugriff' }) };
  }
  if (!title || !body) {
    return { statusCode: 400, body: JSON.stringify({ error: 'title und body sind Pflicht' }) };
  }

  try {
    const query = leader_id && leader_id !== 'all'
      ? `leader_id=eq.${leader_id}`
      : undefined; // kein Filter = alle

    const subs = await pgrest('push_subscriptions', { query });

    let sent = 0;
    let removed = 0;
    for (const sub of subs || []) {
      try {
        await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          { title, body, url: '/' }
        );
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pgrest('push_subscriptions', { method: 'DELETE', query: `id=eq.${sub.id}` });
          removed++;
        }
        // andere Fehler (z.B. kurzzeitig nicht erreichbar) werden ignoriert,
        // nicht die ganze Aktion abbrechen lassen
      }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, sent, removed, total: (subs || []).length }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
