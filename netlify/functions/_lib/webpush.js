// netlify/functions/_lib/webpush.js
//
// Dünner Wrapper um die web-push-Bibliothek (die einzige npm-Abhängigkeit
// in diesem Projekt — echtes Web Push braucht VAPID/aes128gcm-Verschlüsselung,
// die von Hand nachzubauen fehleranfällig wäre).

const webpush = require('web-push');

let configured = false;
function ensureConfigured() {
  if (configured) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error('VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY fehlen');
  webpush.setVapidDetails(
    'mailto:' + (process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com'),
    pub,
    priv
  );
  configured = true;
}

// subscription: { endpoint, keys: { p256dh, auth } } — wie vom Browser geliefert
async function sendPush(subscription, payload) {
  ensureConfigured();
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}

module.exports = { sendPush };
