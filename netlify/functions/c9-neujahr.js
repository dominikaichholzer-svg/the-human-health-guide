// netlify/functions/c9-neujahr.js
//
// Road to 200: Neujahrs-Umfrage zur C9-Challenge (neujahr-challenge.html).
// Eine Funktion für alle Partnerinnen, erkannt am slug aus dem Link.
//
// GET  ?p=<slug>                       -> { name, whatsapp }  (für die Seite)
// GET  ?stats=1                        -> { goal, bestellt, umfragen, partnerinnen } (Team-Zähler)
// POST { p, name, phone, email?, answers, consent }  -> { id }
//      speichert in c9_leads und schickt Dominik eine Benachrichtigung
// POST { id, event: "wa" | "friend" }  -> merkt, ob sie selbst auf WhatsApp
//      geschrieben oder an eine Freundin weitergeleitet hat (für die Quote)
//
// Tabellen: supabase/neujahr-challenge.sql

const { pgrest } = require('./_lib/supabase');

const SLUG = /^[a-z0-9-]{2,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONSENT_TEXT = 'Ich bin einverstanden, dass mich {name} zu meiner Auswertung und zur C9-Neujahrs-Challenge per WhatsApp, Telefon oder E-Mail kontaktiert. Ich kann das jederzeit mit einer kurzen Nachricht widerrufen.';
const ALLOWED = {
  ziel: ['abnehmen', 'energie', 'bauch', 'essen', 'bewegung'],
  hindernis: ['heisshunger', 'zeit', 'allein', 'anfang', 'muede'],
  alltag: ['fruehstueck', 'nachmittag', 'abends', 'wasser', 'passt'],
  start: ['gruppe', 'freundin', 'allein', 'infos'],
};

const json = (status, obj) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

async function partner(slug) {
  if (!SLUG.test(slug || '')) return null;
  const rows = await pgrest('c9_partners', { query: `slug=eq.${slug}&active=eq.true&select=slug,name,whatsapp` });
  return rows && rows[0] ? rows[0] : null;
}

async function notify(p, lead, labels) {
  const key = process.env.RESEND_API_KEY;
  // wie bei den bisherigen Umfragen (subscribe-geschenke-dominik.js)
  const to = process.env.NOTIFY_EMAIL_DOMINIK || process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com';
  if (!key) return;
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wa = String(lead.phone).replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0/, '43');
  const html = `<p><b>${esc(lead.name)}</b> hat die Neujahrs-Umfrage über den Link von <b>${esc(p.name)}</b> ausgefüllt.</p>
<p>Handy: ${esc(lead.phone)} · <a href="https://wa.me/${wa}">auf WhatsApp öffnen</a>${lead.email ? `<br>E-Mail: ${esc(lead.email)}` : ''}</p>
<p>Ziel: ${esc(labels.ziel)}<br>Bisher im Weg: ${esc(labels.hindernis)}<br>Alltag: ${esc(labels.alltag)}<br>Start: ${esc(labels.start)}</p>
<p>Nächster Schritt: heute noch eine kurze Sprachnachricht schicken.</p>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: 'Road to 200 <onboarding@resend.dev>', to: [to], subject: `🎆 Neujahrs-Umfrage: ${lead.name} (${p.name})`, html }),
    });
  } catch (e) { /* Benachrichtigung darf das Speichern nicht verhindern */ }
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      // Öffentlicher Team-Zähler (road-to-200.html): nur Summen, keine Namen
      if ((event.queryStringParameters || {}).stats === '1') {
        const rows = (await pgrest('c9_leads', { query: 'select=status,consent_text&limit=5000' })) || [];
        return json(200, {
          goal: 200,
          bestellt: rows.filter((r) => r.status === 'bestellt').length,
          umfragen: rows.filter((r) => !String(r.consent_text).startsWith('Manuell')).length,
          partnerinnen: ((await pgrest('c9_partners', { query: 'active=eq.true&select=slug' })) || []).length,
        });
      }
      const p = await partner((event.queryStringParameters || {}).p);
      if (!p) return json(404, { error: 'Unbekannter Link' });
      return json(200, { name: p.name, whatsapp: p.whatsapp || null });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let b;
    try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültige Anfrage' }); }

    // Klick-Ereignisse nach dem Absenden
    if (b.id) {
      if (!UUID.test(b.id) || !['wa', 'friend'].includes(b.event)) return json(400, { error: 'Ungültig' });
      const col = b.event === 'wa' ? 'wa_clicked_at' : 'friend_shared_at';
      await pgrest('c9_leads', { method: 'PATCH', query: `id=eq.${b.id}&${col}=is.null`, body: { [col]: new Date().toISOString() } });
      return json(200, { ok: true });
    }

    if (b.website) return json(200, { id: null }); // Spam-Falle (verstecktes Feld)
    const p = await partner(b.p);
    if (!p) return json(404, { error: 'Unbekannter Link' });
    const name = clean(b.name, 80);
    const phone = clean(b.phone, 40);
    const email = clean(b.email, 120);
    if (!name) return json(400, { error: 'Bitte gib deinen Namen ein.' });
    if (phone.replace(/[^\d]/g, '').length < 7) return json(400, { error: 'Bitte gib deine Handynummer ein.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'Die E-Mail-Adresse stimmt nicht ganz.' });
    if (b.consent !== true) return json(400, { error: 'Bitte bestätige die Einwilligung.' });

    const a = b.answers || {};
    const answers = {};
    const labels = {};
    for (const k of Object.keys(ALLOWED)) {
      const v = a[k] && a[k].value;
      // Ziel: Mehrfachauswahl (Liste), alle anderen Fragen: eine Antwort
      const ok = k === 'ziel'
        ? Array.isArray(v) && v.length > 0 && v.length <= ALLOWED.ziel.length && v.every((x) => ALLOWED.ziel.includes(x))
        : ALLOWED[k].includes(v);
      if (!ok) return json(400, { error: 'Bitte beantworte alle Fragen.' });
      answers[k] = k === 'ziel' ? [...new Set(v)] : v;
      labels[k] = clean(a[k].label, k === 'ziel' ? 400 : 120);
    }
    answers.labels = labels;

    const rows = await pgrest('c9_leads', {
      method: 'POST',
      prefer: 'return=representation',
      body: [{ partner_slug: p.slug, name, phone, email: email || null, answers, consent_text: CONSENT_TEXT.replace('{name}', p.name) }],
    });
    const lead = rows && rows[0];
    await notify(p, { name, phone, email }, labels);
    return json(200, { id: lead ? lead.id : null });
  } catch (err) {
    console.error('c9-neujahr', err.message, err.data || '');
    return json(500, { error: 'Gerade hat etwas nicht geklappt. Versuch es bitte gleich nochmal.' });
  }
};
