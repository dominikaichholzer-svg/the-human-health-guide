// netlify/functions/admin-save-products.js
//
// POST /.netlify/functions/admin-save-products
// Body: { key, leader_id, specialized_products }   // Freitext, z.B. 5 Produkte als Liste
//
// Dominik legt pro Leaderin fest, auf welche Produkte sie sich spezialisiert.

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

  const { key, leader_id, specialized_products } = payload;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Kein Zugriff' }) };
  }
  if (!leader_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'leader_id fehlt' }) };
  }

  try {
    await pgrest('leaders', {
      method: 'PATCH',
      query: `id=eq.${leader_id}`,
      body: { specialized_products: specialized_products || null },
    });
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
