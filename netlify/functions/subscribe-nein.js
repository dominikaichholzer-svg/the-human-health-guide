// netlify/functions/subscribe-nein.js
//
// Diese Funktion läuft NICHT im Browser, sondern auf Netlifys Servern.
// API-Keys stecken hier als Umgebungsvariablen (siehe Anleitung unten)
// und werden niemals an den Browser der Besucher ausgeliefert.
//
// Aufruf vom "Kurzes Feedback"-Quiz (nein-quiz.html) aus:
//   POST /.netlify/functions/subscribe-nein
//   Body: {
//     "email": "...",
//     "grund_nein": "...",
//     "geschaeft_grund": "...",
//     "produkttester": "ja" | "nein",
//     "produkttester_kategorie": "...",
//     "aenderung_bedingung": "...",
//     "interesse_wiedervorlage": "...",
//     "geschenk_wahl": "...",
//     "name": "...",
//     "adresse": "..."
//   }
//
// Macht zwei Dinge, unabhängig voneinander:
//   1. Legt/aktualisiert den Kontakt in MailerLite (MAILERLITE_API_KEY,
//      optional MAILERLITE_NEIN_GROUP_ID).
//   2. Schickt eine Benachrichtigungs-Mail mit allen Angaben an Dominik
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
    email,
    grund_nein,
    geschaeft_grund,
    produkttester,
    produkttester_kategorie,
    aenderung_bedingung,
    interesse_wiedervorlage,
    geschenk_wahl,
    name,
    adresse,
  } = payload;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-Mail fehlt oder ungültig' }) };
  }

  const results = { mailerlite: null, notify: null };

  // 1. MailerLite-Kontakt anlegen/aktualisieren
  const ML_API_KEY = process.env.MAILERLITE_API_KEY;
  const ML_GROUP_ID = process.env.MAILERLITE_NEIN_GROUP_ID;

  if (ML_API_KEY) {
    try {
      const mlBody = {
        email: email,
        fields: {
          grund_nein: grund_nein || '',
          geschaeft_grund: geschaeft_grund || '',
          produkttester: produkttester || 'nein',
          produkttester_kategorie: produkttester_kategorie || '',
          aenderung_bedingung: aenderung_bedingung || '',
          interesse_wiedervorlage: interesse_wiedervorlage || '',
          geschenk_wahl: geschenk_wahl || '',
          name: name || '',
          adresse: adresse || '',
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
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com';

  if (RESEND_API_KEY) {
    const rows = [
      ['E-Mail', email],
      ['Name', name || '–'],
      ['Lieferadresse', adresse || '–'],
      ['Gewähltes Geschenk', geschenk_wahl || '–'],
      ['Grund fürs Nein', grund_nein || '–'],
      ['Geschäft: Grund', geschaeft_grund || '–'],
      ['Produkttester', produkttester || '–'],
      ['Produkttester-Kategorie', produkttester_kategorie || '–'],
      ['Änderung nötig', aenderung_bedingung || '–'],
      ['Interesse an Wiedervorlage', interesse_wiedervorlage || '–'],
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
          from: 'Nein-Quiz <onboarding@resend.dev>',
          to: [NOTIFY_EMAIL],
          subject: `Neue Nein-Quiz Anmeldung${name ? ': ' + name : ''}`,
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
