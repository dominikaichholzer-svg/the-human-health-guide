// netlify/functions/subscribe-geschenke-frank.js
//
// Diese Funktion läuft NICHT im Browser, sondern auf Netlifys Servern.
// API-Keys stecken hier als Umgebungsvariablen und werden niemals an
// den Browser der Besucher ausgeliefert.
//
// Aufruf von der Geschenke-Umfrage für Frank (geschenke-umfrage-frank.html) aus:
//   POST /.netlify/functions/subscribe-geschenke-frank
//   Body: {
//     "name": "...",
//     "kontakt": "...",       // Handynummer oder Instagram-Name
//     "email": "...",
//     "fuer_wen": "...",         // Antwort Frage 1
//     "bereich": "...",          // Antwort Frage 2, entscheidet das Set
//     "budget": "...",           // Antwort Frage 3
//     "anzahl": "...",           // Antwort Frage 4
//     "empfohlenes_set": "..."   // z. B. "Men Care (49,90 €)"
//   }
//
// Macht zwei Dinge, unabhängig voneinander:
//   1. Legt/aktualisiert den Kontakt in MailerLite (MAILERLITE_API_KEY,
//      optional MAILERLITE_GESCHENKE_FRANK_GROUP_ID).
//   2. Schickt eine Benachrichtigungs-Mail mit allen Angaben an Frank
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
    bereich,
    anzahl,
    empfohlenes_set,
  } = payload;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-Mail fehlt oder ungültig' }) };
  }

  const results = { mailerlite: null, notify: null };

  // 1. MailerLite-Kontakt anlegen/aktualisieren
  const ML_API_KEY = process.env.MAILERLITE_API_KEY;
  const ML_GROUP_ID = process.env.MAILERLITE_GESCHENKE_FRANK_GROUP_ID;

  if (ML_API_KEY) {
    try {
      const mlBody = {
        email: email,
        fields: {
          name: name || '',
          kontakt: kontakt || '',
          fuer_wen: fuer_wen || '',
          budget: budget || '',
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
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL_FRANK || 'dominikaichholzer@gmail.com';

  if (RESEND_API_KEY) {
    const rows = [
      ['Name', name || '–'],
      ['Kontakt (Handy/Instagram)', kontakt || '–'],
      ['E-Mail', email],
      ['Für wen gesucht', fuer_wen || '–'],
      ['Bereich', bereich || '–'],
      ['Budget', budget || '–'],
      ['Anzahl Geschenke', anzahl || '–'],
      ['Empfohlenes Set', empfohlenes_set || '–'],
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
          subject: `Neue Geschenke-Umfrage Anmeldung (über Frank)${name ? ': ' + name : ''}`,
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
