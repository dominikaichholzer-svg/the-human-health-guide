// netlify/functions/scheduled-daily-reflection-push.js
//
// Jeden Abend um 19:00 (Wiener Zeit) eine Erinnerung an die Tagesreflexion.
// Netlify plant in UTC, Wien ist UTC+1 (Winter) bzw. UTC+2 (Sommer). Darum
// läuft die Funktion um 17:00 und 18:00 UTC (siehe netlify.toml) und wird
// nur aktiv, wenn es in Wien gerade 19 Uhr ist. So feuert sie das ganze
// Jahr genau einmal pro Abend.
//
// - Tagesreflexion noch nicht ausgefüllt: Erinnerung dazu.
// - Sonntags zusätzlich: Wochenreflexion noch offen? Dann wird sie erwähnt,
//   auch wenn die Tagesreflexion schon da ist.
// - Ab dem 25.: fehlt die Monatsplanung für den nächsten Monat, kommt jeden
//   Abend diese Erinnerung (sie hat Vorrang, weil das Dashboard bis dahin
//   gesperrt ist).
// Wer keine Push-Benachrichtigung aktiviert hat, bekommt nichts.

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');
const { viennaTodayStr } = require('./_lib/ranks');
const { dashboardUrl } = require('./_lib/pushlinks');
const { planWindow } = require('./_lib/plan');

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function viennaParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Vienna', hour: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(new Date());
  const hour = Number(fmt.find((p) => p.type === 'hour').value) % 24;
  const weekday = fmt.find((p) => p.type === 'weekday').value;
  return { hour, isSunday: weekday === 'Sun' };
}

exports.handler = async function () {
  const { hour, isSunday } = viennaParts();
  if (hour !== 19) {
    return { statusCode: 200, body: JSON.stringify({ skipped: `in Wien ist es ${hour} Uhr, nicht 19` }) };
  }

  try {
    const today = viennaTodayStr();
    const weekStart = mondayOf(today);
    const pw = planWindow(today);
    const leaders = await pgrest('leaders', { query: 'select=*' });
    const results = [];

    for (const leader of leaders) {
      const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
      if (!subs || subs.length === 0) {
        results.push({ leader: leader.name, skipped: 'kein Push aktiviert' });
        continue;
      }

      // Monatsplanung fällig? (nur ab dem 25. für den nächsten Monat)
      if (pw.day >= 25) {
        let planDone = true;
        try {
          const plan = await pgrest('monthly_plans', {
            query: `leader_id=eq.${leader.id}&target_month=eq.${pw.next}&select=id`,
          });
          planDone = !!(plan && plan.length);
        } catch (e) { planDone = true; }
        if (!planDone) {
          const planPayload = {
            title: 'Deine Monatsplanung ist fällig 🗓️',
            body: 'Bis du sie abgibst, ist dein Dashboard gesperrt. Dauert etwa 5 Minuten.',
            url: dashboardUrl(leader, 'plan'),
          };
          let planSent = 0;
          for (const sub of subs) {
            try {
              await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, planPayload);
              planSent++;
            } catch (err) {
              if (err.statusCode === 404 || err.statusCode === 410) {
                await pgrest('push_subscriptions', { method: 'DELETE', query: `id=eq.${sub.id}` });
              }
            }
          }
          results.push({ leader: leader.name, plan: true, sent: planSent });
          continue;
        }
      }

      const day = await pgrest('daily_reflections', {
        query: `leader_id=eq.${leader.id}&entry_date=eq.${today}&select=id`,
      });
      const dayDone = !!(day && day.length);

      let weekDone = true;
      if (isSunday) {
        const week = await pgrest('weekly_entries', {
          query: `leader_id=eq.${leader.id}&week_start=eq.${weekStart}&select=id`,
        });
        weekDone = !!(week && week.length);
      }

      let payload = null;
      if (!dayDone && !weekDone) {
        payload = {
          title: 'Dein Tagesabschluss 🌙',
          body: 'Tages- und Wochenreflexion warten auf dich. Zusammen etwa 5 Minuten.',
          url: dashboardUrl(leader, 'entry', 'daily'),
        };
      } else if (!dayDone) {
        payload = {
          title: 'Dein Tagesabschluss 🌙',
          body: 'Was lief heute gut? 2 Minuten reichen.',
          url: dashboardUrl(leader, 'entry', 'daily'),
        };
      } else if (!weekDone) {
        payload = {
          title: 'Deine Wochenreflexion 📝',
          body: 'Die Woche ist fast vorbei. Trag deine Zahlen ein und schau zurück.',
          url: dashboardUrl(leader, 'entry', 'weekly'),
        };
      }
      if (!payload) {
        results.push({ leader: leader.name, skipped: 'alles erledigt' });
        continue;
      }

      let sent = 0;
      for (const sub of subs) {
        try {
          await sendPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
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
