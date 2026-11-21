// netlify/functions/c9-neujahr.js
//
// Road to 200: Neujahrs-Umfrage zur C9-Challenge (neujahr-challenge.html).
// Eine Funktion für alle Partnerinnen, erkannt am slug aus dem Link.
//
// GET  ?p=<slug>                       -> { name, whatsapp }  (für die Seite)
// POST { dabei: true, p, name, phone, consent } -> "Ich bin dabei": als bestellt eintragen, { groupLink }
// POST { advent: true, p, ev, day? }  -> anonymes Ereignis aus dem Adventskalender zählen
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
// Kam die Anmeldung über die Umfrage (nicht manuell oder über "Ich bin dabei")?
const isSurvey = (l) => !!(l.answers && l.answers.ziel);
// Handynummern vergleichen: nur Ziffern, die letzten 9 (egal ob 0664, +43 664 oder 0043 664)
const phoneKey = (v) => String(v || '').replace(/[^\d]/g, '').slice(-9);
const DABEI_TEXT = 'Ich habe das C9 über den Link von {name} bestellt und bin einverstanden, dass {name} mich für die Challenge per WhatsApp kontaktiert und in die Challenge-Gruppe aufnimmt.';
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

async function notifyDabei(p, name, phone) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL_DOMINIK || process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com';
  if (!key) return;
  const esc = (t) => String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: 'Road to 200 <onboarding@resend.dev>', to: [to],
        subject: `🎉 Neue Teilnehmerin: ${name} (${p.name})`,
        html: `<p><b>${esc(name)}</b> hat sich als Teilnehmerin der C9-Neujahrs-Challenge eingetragen (über ${esc(p.name)}).</p><p>Handy: ${esc(phone)}</p><p>Sie zählt jetzt im Road-to-200-Zähler. Bestellung bei Bedarf in FLP360 gegenprüfen.</p>`,
      }),
    });
  } catch (e) { /* egal */ }
}

exports.handler = async function (event) {
  try {
    if (event.httpMethod === 'GET') {
      // Öffentlicher Team-Zähler (road-to-200.html): nur Summen, keine Namen
      if ((event.queryStringParameters || {}).stats === '1') {
        const rows = (await pgrest('c9_leads', { query: 'select=status,answers&limit=5000' })) || [];
        return json(200, {
          goal: 200,
          bestellt: rows.filter((r) => r.status === 'bestellt').length,
          umfragen: rows.filter(isSurvey).length,
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

    // Adventskalender: anonyme Zahlen (keine Personendaten), siehe advent.html
    if (b.advent) {
      const EV = ['besuch', 'tuerchen', 'dabei', 'quiz', 'foto', 'wunsch', 'angebot', 'beratung', 'umfrage'];
      const ev = String(b.ev || '');
      const day = b.day == null ? null : Number(b.day);
      if (!SLUG.test(b.p || '') || !EV.includes(ev) || (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 24))) return json(400, { error: 'Ungültig' });
      try { await pgrest('advent_events', { method: 'POST', body: [{ partner_slug: b.p, event: ev, day }] }); } catch (e) { /* unbekannte Partnerin oder Tabelle fehlt: still ignorieren */ }
      return json(200, { ok: true });
    }

    // "Ich bin dabei" (/dabei/<slug>): nach der Bestellung selbst eintragen,
    // zählt als bestellt und gibt den Link zur WhatsApp-Gruppe zurück
    if (b.dabei) {
      const pd = await partner(b.p);
      if (!pd) return json(404, { error: 'Unbekannter Link' });
      const name = clean(b.name, 80);
      const phone = clean(b.phone, 40);
      if (!name) return json(400, { error: 'Bitte gib deinen Namen ein.' });
      if (phone.replace(/[^\d]/g, '').length < 7) return json(400, { error: 'Bitte gib deine Handynummer ein.' });
      if (b.consent !== true) return json(400, { error: 'Bitte bestätige kurz die Bestellung und die Einwilligung.' });
      const now = new Date().toISOString();
      const key = phoneKey(phone);
      // Schon über die Umfrage da? Dann diesen Eintrag auf bestellt setzen statt doppelt zählen
      const mine = (await pgrest('c9_leads', { query: `partner_slug=eq.${pd.slug}&select=id,phone,status,confirmed_at&order=created_at.desc&limit=2000` })) || [];
      const hit = mine.find((l) => phoneKey(l.phone) === key);
      let isNew = false;
      if (hit) {
        if (!hit.confirmed_at || hit.status !== 'bestellt') {
          await pgrest('c9_leads', { method: 'PATCH', query: `id=eq.${hit.id}`, body: { status: 'bestellt', ordered_at: now, confirmed_at: now } });
          isNew = hit.status !== 'bestellt';
        }
      } else {
        await pgrest('c9_leads', { method: 'POST', body: [{ partner_slug: pd.slug, name, phone, answers: {}, status: 'bestellt', ordered_at: now, confirmed_at: now, consent_text: DABEI_TEXT.replace(/\{name\}/g, pd.name) }] });
        isNew = true;
      }
      if (isNew) await notifyDabei(pd, name, phone);
      let groupLink = null;
      try {
        const st = await pgrest('c9_settings', { query: 'key=eq.group_link&select=value' });
        groupLink = st && st[0] && st[0].value ? st[0].value : null;
      } catch (e) { groupLink = null; }
      return json(200, { ok: true, groupLink, partner: pd.name });
    }

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
