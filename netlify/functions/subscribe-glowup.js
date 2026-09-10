// netlify/functions/subscribe-glowup.js
//
// Diese Funktion läuft NICHT im Browser, sondern auf Netlifys Servern.
// API-Keys stecken hier als Umgebungsvariablen und werden niemals an
// den Browser der Besucher ausgeliefert.
//
// Aufruf vom Glow-up Quiz (glowup-quiz.html) aus:
//   POST /.netlify/functions/subscribe-glowup
//   Body: {
//     "name": "...",
//     "kontakt": "...",       // Handynummer oder Instagram-Name
//     "email": "...",
//     "produkttester": "...",       // Antwort Frage 1
//     "bio_face_lifting": "...",    // Antwort Frage 2
//     "glowup_event": "...",        // Antwort Frage 3
//     "gastgeber": "..."            // Antwort Frage 4
//   }
//
// Macht zwei Dinge, unabhängig voneinander:
//   1. Legt/aktualisiert den Kontakt in MailerLite (MAILERLITE_API_KEY,
//      optional MAILERLITE_GLOWUP_GROUP_ID).
//   2. Schickt eine Benachrichtigungs-Mail mit allen Angaben an Dominik
//      über Resend (RESEND_API_KEY, NOTIFY_EMAIL). Nutzt die gleichen
//      Umgebungsvariablen wie subscribe-nein.js, die auf Netlify schon
//      hinterlegt sind.

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
    produkttester,
    bio_face_lifting,
    glowup_event,
    gastgeber,
    neustart,
  } = payload;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-Mail fehlt oder ungültig' }) };
  }

  const results = { mailerlite: null, notify: null };

  // 1. MailerLite-Kontakt anlegen/aktualisieren
  const ML_API_KEY = process.env.MAILERLITE_API_KEY;
  const ML_GROUP_ID = process.env.MAILERLITE_GLOWUP_GROUP_ID;

  if (ML_API_KEY) {
    try {
      const mlBody = {
        email: email,
        fields: {
          name: name || '',
          kontakt: kontakt || '',
          produkttester: produkttester || '',
          bio_face_lifting: bio_face_lifting || '',
          glowup_event: glowup_event || '',
          gastgeber: gastgeber || '',
          neustart: neustart || '',
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
      ['Name', name || '–'],
      ['Kontakt (Handy/Instagram)', kontakt || '–'],
      ['E-Mail', email],
      ['Gesichtspflege testen', produkttester || '–'],
      ['Bio Face Lifting', bio_face_lifting || '–'],
      ['Glow-up Event', glowup_event || '–'],
      ['Gastgeber:in werden', gastgeber || '–'],
      ['Neustart nach dem Sommer', neustart || '–'],
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
          from: 'Glow-up Quiz <onboarding@resend.dev>',
          to: [NOTIFY_EMAIL],
          subject: `Neue Glow-up Quiz Anmeldung${name ? ': ' + name : ''}`,
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
