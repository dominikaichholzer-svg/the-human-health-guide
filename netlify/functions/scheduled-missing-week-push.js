// netlify/functions/scheduled-missing-week-push.js
//
// Läuft täglich (siehe netlify.toml), wird aber nur donnerstags aktiv.
// Schickt eine automatische Erinnerungs-Push an jede Leaderin, die diese
// Woche noch keinen Eintrag gemacht hat (falls sie Push aktiviert hat).

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');
const { viennaTodayStr } = require('./_lib/ranks');

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function viennaWeekday() {
  // 1 = Montag ... 7 = Sonntag
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna', weekday: 'short' }).format(new Date());
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[parts] || 0;
}

exports.handler = async function () {
  if (viennaWeekday() !== 4) { // nur donnerstags
    return { statusCode: 200, body: JSON.stringify({ skipped: 'nicht Donnerstag' }) };
  }

  try {
    const today = viennaTodayStr();
    const currentWeekMonday = mondayOf(today);

    const leaders = await pgrest('leaders', { query: 'select=id,name' });
    const results = [];

    for (const leader of leaders) {
      const entries = await pgrest('weekly_entries', {
        query: `leader_id=eq.${leader.id}&week_start=eq.${currentWeekMonday}&select=id`,
      });
      if (entries && entries.length > 0) {
        results.push({ leader: leader.name, skipped: 'schon eingetragen' });
        continue;
      }

      const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
      if (!subs || subs.length === 0) {
        results.push({ leader: leader.name, skipped: 'kein Push aktiviert' });
        continue;
      }

      let sent = 0;
      for (const sub of subs) {
        try {
          await sendPush(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            { title: 'Nicht vergessen 👋', body: 'Diese Woche noch keine Zahlen eingetragen. 2 Minuten reichen.', url: '/leader-dashboard.html' }
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

    return { statusCode: 200, body: JSON.stringify({ results }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
