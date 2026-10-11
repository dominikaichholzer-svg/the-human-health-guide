// netlify/functions/leader-save-vision.js
//
// POST /.netlify/functions/leader-save-vision
// Body: { token, vision_image_url }
//
// Speichert den Bild-Link fürs persönliche Vision-Board. Bewusst nur ein
// Link, kein Datei-Upload, damit es eine "leicht aufgebaute Seite" bleibt.

const { pgrest } = require('./_lib/supabase');

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

  const { token, vision_image_url } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }
  if (vision_image_url && !/^https?:\/\//.test(vision_image_url)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bild-Link muss mit http:// oder https:// beginnen' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    await pgrest('leaders', {
      method: 'PATCH',
      query: `id=eq.${leaderId}`,
      body: { vision_image_url: vision_image_url || null },
    });

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
