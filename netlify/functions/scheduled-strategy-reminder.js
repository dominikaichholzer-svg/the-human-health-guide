// netlify/functions/scheduled-strategy-reminder.js
//
// Läuft täglich (siehe netlify.toml) und prüft, ob Dominik die Strategie
// für den nächsten Monat schon eingetragen hat. Ab dem 26. des Monats:
// falls noch leer UND noch keine Erinnerung verschickt wurde, geht eine
// Mail über Resend raus (gleiches Muster wie subscribe-geschenke.js) und
// reminder_sent_at wird gesetzt, damit nicht jeden Tag erneut gemailt wird.

const { pgrest } = require('./_lib/supabase');
const { viennaTodayStr } = require('./_lib/ranks');

function nextMonthStart(todayStr) {
  const [y, m] = todayStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 10);
}

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

exports.handler = async function () {
  const today = viennaTodayStr();
  const day = Number(today.slice(8, 10));

  if (day < 26) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'vor dem 26.' }) };
  }

  const targetMonth = nextMonthStart(today);

  try {
    const rows = await pgrest('monthly_strategy', {
      query: `target_month=eq.${targetMonth}&select=content,reminder_sent_at`,
    });
    const row = rows && rows[0];

    const hasContent = !!(row && row.content && row.content.trim().length > 0);
    if (hasContent) {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'Strategie schon eingetragen' }) };
    }

    const alreadyReminded = !!(row && row.reminder_sent_at);
    if (alreadyReminded) {
      return { statusCode: 200, body: JSON.stringify({ skipped: 'Erinnerung schon verschickt' }) };
    }

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com';
    const [y, m] = targetMonth.split('-').map(Number);
    const monthLabel = `${MONTH_NAMES_DE[m - 1]} ${y}`;

    if (RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: 'Team-Dashboard <onboarding@resend.dev>',
          to: [NOTIFY_EMAIL],
          subject: `Erinnerung: Strategie für ${monthLabel} fehlt noch`,
          html: `<p>Du hast die Strategie/Monatsplanung für <b>${monthLabel}</b> noch nicht eingetragen.</p><p>Die Leaderinnen sehen auf ihrem Dashboard ab dem 1. ${monthLabel.split(' ')[0]} eine Wartenachricht statt ihrer neuen Ziele, bis du sie einträgst.</p>`,
        }),
      });
    }

    // on_conflict upsert, content bewusst NICHT mitsenden, damit ein leerer
    // Text hier nie einen eventuell zwischenzeitlich gespeicherten Inhalt
    // überschreibt
    await pgrest('monthly_strategy', {
      method: 'POST',
      query: 'on_conflict=target_month',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{ target_month: targetMonth, reminder_sent_at: new Date().toISOString() }],
    });

    return { statusCode: 200, body: JSON.stringify({ reminded: true, targetMonth }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
