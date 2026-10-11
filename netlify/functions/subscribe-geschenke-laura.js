// netlify/functions/subscribe-geschenke-laura.js
//
// Diese Funktion läuft NICHT im Browser, sondern auf Netlifys Servern.
// API-Keys stecken hier als Umgebungsvariablen und werden niemals an
// den Browser der Besucher ausgeliefert.
//
// Aufruf von der Geschenke-Umfrage für Laura (geschenke-umfrage-laura.html) aus:
//   POST /.netlify/functions/subscribe-geschenke-laura
//   Body: {
//     "name": "...",
//     "kontakt": "...",       // Handynummer oder Instagram-Name
//     "email": "...",
//     "fuer_wen": "...",         // Antwort Frage 1
//     "budget": "...",           // Antwort Frage 2
//     "selbst_beschenkt": "...", // Antwort Frage 3
//     "wichtigkeit": "..."       // Antwort Frage 4
//   }
//
// Macht zwei Dinge, unabhängig voneinander:
//   1. Legt/aktualisiert den Kontakt in MailerLite (MAILERLITE_API_KEY,
//      optional MAILERLITE_GESCHENKE_LAURA_GROUP_ID).
//   2. Schickt eine Benachrichtigungs-Mail mit allen Angaben an Laura
//      über Resend (RESEND_API_KEY, NOTIFY_EMAIL).

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

  const {
    name,
    kontakt,
    email,
    fuer_wen,
    budget,
    selbst_beschenkt,
    wichtigkeit,
  } = payload;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-Mail fehlt oder ungültig' }) };
  }

  const results = { mailerlite: null, notify: null };

  // 1. MailerLite-Kontakt anlegen/aktualisieren
  const ML_API_KEY = process.env.MAILERLITE_API_KEY;
  const ML_GROUP_ID = process.env.MAILERLITE_GESCHENKE_LAURA_GROUP_ID;

  if (ML_API_KEY) {
    try {
      const mlBody = {
        email: email,
        fields: {
          name: name || '',
          kontakt: kontakt || '',
          fuer_wen: fuer_wen || '',
          budget: budget || '',
          selbst_beschenkt: selbst_beschenkt || '',
          wichtigkeit: wichtigkeit || '',
        },
        groups: ML_GROUP_ID ? [ML_GROUP_ID] : [],
        status: 'active',
      };

      const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${ML_API_KEY}`,
        },
        body: JSON.stringify(mlBody),
      });
      results.mailerlite = { ok: mlRes.ok, status: mlRes.status };
    } catch (err) {
      results.mailerlite = { ok: false, error: err.message };
    }
  }

  // 2. Benachrichtigungs-Mail an Dominik über Resend
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL_LAURA || 'dominikaichholzer@gmail.com';

  if (RESEND_API_KEY) {
    const rows = [
      ['Name', name || '–'],
      ['Kontakt (Handy/Instagram)', kontakt || '–'],
      ['E-Mail', email],
      ['Für wen gesucht', fuer_wen || '–'],
      ['Budget pro Geschenk', budget || '–'],
      ['Selbst zuletzt beschenkt', selbst_beschenkt || '–'],
      ['Wichtig beim Geschenk', wichtigkeit || '–'],
    ];
    const htmlRows = rows
      .map(([label, value]) => `<tr><td style="padding:6px 12px 6px 0;color:#666;white-space:nowrap;">${label}</td><td style="padding:6px 0;"><b>${value}</b></td></tr>`)
      .join('');

    try {
      const notifyRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: 'Geschenke-Umfrage <onboarding@resend.dev>',
          to: [NOTIFY_EMAIL],
          subject: `Neue Geschenke-Umfrage Anmeldung (über Laura)${name ? ': ' + name : ''}`,
          html: `<table>${htmlRows}</table>`,
        }),
      });
      results.notify = { ok: notifyRes.ok, status: notifyRes.status };
    } catch (err) {
      results.notify = { ok: false, error: err.message };
    }
  }

  return { statusCode: 200, body: JSON.stringify({ success: true, results }) };
};
