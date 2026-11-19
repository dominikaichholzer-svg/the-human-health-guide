// netlify/functions/scheduled-reminders.js
//
// Läuft alle 15 Minuten (netlify.toml) und schickt die Erinnerungen zur
// Uhrzeit, die jede Leaderin selbst gewählt hat (supabase/reminders.sql):
//
// - täglich zur gewählten Zeit: Tagesreflexion von heute fehlt
// - sonntags zur gewählten Zeit: Wochenreflexion dieser Woche fehlt
// - jeden Morgen 08:00: gestern keine Tagesreflexion und/oder Wochenreflexion
//   der letzten Woche fehlt noch -> automatisch, jeden Tag, bis sie drin ist
// - ab dem 25. zur täglichen Zeit: Monatsplanung fehlt (hat Vorrang)
// Pausierte Leaderinnen und wer keinen Push aktiviert hat, bekommt nichts.
// reminder_log verhindert, dass etwas doppelt kommt.

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');
const { viennaTodayStr } = require('./_lib/ranks');
const { dashboardUrl } = require('./_lib/pushlinks');
const { planWindow } = require('./_lib/plan');

const MORNING = '08:00';

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  return addDays(dateStr, -(day - 1));
}
// Aktuelle Viertelstunde in Wien, z. B. "19:15", und ob Sonntag ist
function viennaSlot(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Vienna', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const h = Number(get('hour')) % 24;
  const m = Math.floor(Number(get('minute')) / 15) * 15;
  return { slot: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, isSunday: get('weekday') === 'Sun' };
}

async function exists(table, query) {
  const rows = await pgrest(table, { query: query + '&select=id&limit=1' });
  return !!(rows && rows.length);
}

// true, wenn diese Erinnerung noch nicht verschickt wurde (und merkt sie sich)
async function claim(leaderId, kind, refDate) {
  let rows;
  try {
    rows = await pgrest('reminder_log', {
    method: 'POST',
    query: 'on_conflict=leader_id,kind,ref_date',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: [{ leader_id: leaderId, kind, ref_date: refDate }],
  });
  } catch (e) { return true; } // Tabelle fehlt noch: lieber schicken (läuft nur 1x pro Viertelstunde)
  return !!(rows && rows.length);
}

async function pushAll(subs, payload) {
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
  return sent;
}

exports.handler = async function () {
  const { slot, isSunday } = viennaSlot();
  try {
    const today = viennaTodayStr();
    const yesterday = addDays(today, -1);
    const weekStart = mondayOf(today);
    const lastWeekStart = addDays(weekStart, -7);
    const pw = planWindow(today);
    const leaders = (await pgrest('leaders', { query: 'select=*&on_hold=is.false' })) || [];
    const due = leaders.filter((l) => slot === MORNING || slot === (l.reminder_daily_time || '19:00') || (isSunday && slot === (l.reminder_weekly_time || '19:00')));
    const results = [];

    for (const leader of due) {
      const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
      if (!subs || !subs.length) continue;
      const dailyTime = leader.reminder_daily_time || '19:00';
      const weeklyTime = leader.reminder_weekly_time || '19:00';

      // Morgens 08:00: Nachholen von gestern / letzter Woche
      if (slot === MORNING) {
        const dayMissing = !(await exists('daily_reflections', `leader_id=eq.${leader.id}&entry_date=eq.${yesterday}`));
        const weekMissing = !(await exists('weekly_entries', `leader_id=eq.${leader.id}&week_start=eq.${lastWeekStart}`));
        let payload = null;
        if (dayMissing && weekMissing) {
          payload = { title: 'Guten Morgen ☀️ Kurz nachtragen', body: 'Deine Tagesreflexion von gestern und die Wochenreflexion fehlen noch. Zusammen etwa 5 Minuten.', url: dashboardUrl(leader, 'entry', 'weekly') };
        } else if (weekMissing) {
          payload = { title: 'Guten Morgen ☀️ Deine Wochenreflexion', body: 'Die Wochenreflexion der letzten Woche fehlt noch. Trag sie gleich ein, dann ist sie erledigt.', url: dashboardUrl(leader, 'entry', 'weekly') };
        } else if (dayMissing) {
          payload = { title: 'Guten Morgen ☀️ Kurz nachtragen', body: 'Die Tagesreflexion von gestern fehlt noch. Unter „Gestern nachtragen“ geht es in 2 Minuten.', url: dashboardUrl(leader, 'entry', 'daily') };
        }
        if (payload && (await claim(leader.id, 'morning', today))) {
          results.push({ leader: leader.name, morning: true, sent: await pushAll(subs, payload) });
        }
      }

      // Monatsplanung fällig (ab dem 25.): zur täglichen Zeit, hat Vorrang
      if (slot === dailyTime && pw.day >= 25) {
        let planDone = true;
        try { planDone = await exists('monthly_plans', `leader_id=eq.${leader.id}&target_month=eq.${pw.next}`); } catch (e) { planDone = true; }
        if (!planDone) {
          if (await claim(leader.id, 'plan', today)) {
            results.push({ leader: leader.name, plan: true, sent: await pushAll(subs, {
              title: 'Deine Monatsplanung ist fällig 🗓️',
              body: 'Bis du sie abgibst, ist dein Dashboard gesperrt. Dauert etwa 5 Minuten.',
              url: dashboardUrl(leader, 'plan'),
            }) });
          }
          continue;
        }
      }

      const dailyNow = slot === dailyTime && !(await exists('daily_reflections', `leader_id=eq.${leader.id}&entry_date=eq.${today}`));
      const weeklyNow = isSunday && slot === weeklyTime && !(await exists('weekly_entries', `leader_id=eq.${leader.id}&week_start=eq.${weekStart}`));
      if (dailyNow && weeklyNow) {
        if ((await claim(leader.id, 'daily', today)) && (await claim(leader.id, 'weekly', today))) {
          results.push({ leader: leader.name, both: true, sent: await pushAll(subs, { title: 'Dein Tagesabschluss 🌙', body: 'Tages- und Wochenreflexion warten auf dich. Zusammen etwa 5 Minuten.', url: dashboardUrl(leader, 'entry', 'daily') }) });
        }
      } else if (dailyNow) {
        if (await claim(leader.id, 'daily', today)) {
          results.push({ leader: leader.name, daily: true, sent: await pushAll(subs, { title: 'Dein Tagesabschluss 🌙', body: 'Was lief heute gut? 2 Minuten reichen.', url: dashboardUrl(leader, 'entry', 'daily') }) });
        }
      } else if (weeklyNow) {
        if (await claim(leader.id, 'weekly', today)) {
          results.push({ leader: leader.name, weekly: true, sent: await pushAll(subs, { title: 'Deine Wochenreflexion 📝', body: 'Die Woche ist vorbei. Trag deine Zahlen ein und schau zurück.', url: dashboardUrl(leader, 'entry', 'weekly') }) });
        }
      }
    }
    return { statusCode: 200, body: JSON.stringify({ slot, results }) };
  } catch (err) {
    console.error('scheduled-reminders', err.message, err.data || '');
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};

exports.viennaSlot = viennaSlot;
