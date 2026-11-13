// netlify/functions/scheduled-challenge-push.js
//
// Montags früh (siehe netlify.toml): Push an jede Leaderin mit aktivierten
// Benachrichtigungen, dass die neue Woche der Leadership-Challenge da ist.
// Nur, wenn für die Woche schon ein Inhalt eingetragen ist.

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');
const { viennaTodayStr } = require('./_lib/ranks');
const { dashboardUrl } = require('./_lib/pushlinks');
const { weekNoFor, WEEKS } = require('./_lib/challenge');

exports.handler = async function () {
  try {
    const weekNo = weekNoFor(viennaTodayStr());
    if (weekNo < 1 || weekNo > WEEKS) return { statusCode: 200, body: JSON.stringify({ skipped: 'Challenge läuft nicht' }) };

    const rows = await pgrest('challenge_weeks', { query: `week_no=eq.${weekNo}&select=impuls,aufgabe,frage` });
    const c = rows && rows[0];
    if (!c || !(c.impuls || c.aufgabe || c.frage)) {
      return { statusCode: 200, body: JSON.stringify({ skipped: `Woche ${weekNo} hat noch keinen Inhalt` }) };
    }
    const preview = String(c.aufgabe || c.impuls || '').replace(/\s+/g, ' ').trim();
    const body = preview.length > 110 ? preview.slice(0, 107) + '…' : preview || 'Dein neuer Impuls ist da.';

    const leaders = await pgrest('leaders', { query: 'select=*' });
    const results = [];
    for (const leader of leaders || []) {
      const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
      let sent = 0;
      for (const sub of subs || []) {
        try {
          await sendPush(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            { title: `Woche ${weekNo} von 52 deiner Leadership-Challenge`, body, url: dashboardUrl(leader) }
          );
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pgrest('push_subscriptions', { method: 'DELETE', query: `id=eq.${sub.id}` });
          }
        }
      }
      results.push({ leader: leader.name, sent });
    }
    return { statusCode: 200, body: JSON.stringify({ weekNo, results }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
