// netlify/functions/subscribe.js
//
// Diese Funktion läuft NICHT im Browser, sondern auf Netlifys Servern.
// Der MailerLite API-Key steckt hier als Umgebungsvariable (siehe Anleitung
// unten) und wird niemals an den Browser der Besucher ausgeliefert.
//
// Aufruf vom Quiz aus: POST /.netlify/functions/subscribe
// Body: { "name": "...", "email": "...", "score": 14 }

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

  const { name, email, score } = payload;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, body: JSON.stringify({ error: 'E-Mail fehlt oder ungültig' }) };
  }

  const API_KEY = process.env.MAILERLITE_API_KEY;   // in Netlify UI setzen
  const GROUP_ID = process.env.MAILERLITE_GROUP_ID;  // in Netlify UI setzen

  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server nicht konfiguriert (API-Key fehlt)' }) };
  }

  const body = {
    email: email,
    fields: {
      name: name || '',
      // Falls du in MailerLite unter Subscribers -> Fields ein eigenes
      // Feld "score" (Zahl) anlegst, wird der Quiz-Score mitgespeichert.
      score: typeof score === 'number' ? score : null,
    },
    groups: GROUP_ID ? [GROUP_ID] : [],
    status: 'active',
  };

  try {
    const response = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
