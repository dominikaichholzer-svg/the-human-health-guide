// netlify/functions/leader-save-push-subscription.js
//
// POST /.netlify/functions/leader-save-push-subscription
// Body: { token, subscription: { endpoint, keys: { p256dh, auth } } }
//
// Speichert die Browser-Push-Subscription einer Leaderin. Eine Person kann
// mehrere Subscriptions haben (z.B. Handy + Laptop), daher upsert auf den
// endpoint statt auf leader_id.

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

  const { token, subscription } = payload;
  if (!token || !subscription || !subscription.endpoint || !subscription.keys) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token oder Subscription fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    await pgrest('push_subscriptions', {
      method: 'POST',
      query: 'on_conflict=endpoint',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{
        leader_id: leaderId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      }],
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
