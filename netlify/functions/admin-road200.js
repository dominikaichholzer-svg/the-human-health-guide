// netlify/functions/admin-road200.js
//
// Road to 200 (nur Admin): Zähler und Leads der Neujahrs-Umfrage.
// GET                                   -> { goal, totals, partners, leads }
// POST { lead_id, status }              -> Status ändern (neu, im_gespraech, bestellt, kein_interesse)
// POST { manual: { partner_slug, name } } -> Teilnehmerin ohne Umfrage als "bestellt" eintragen
// POST { partner: { slug, name, whatsapp, active } } -> Partnerin anlegen oder ändern (Link /neujahr/<slug>)
// Tabellen: supabase/neujahr-challenge.sql

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');

const GOAL = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{2,40}$/;
const STATUS = ['neu', 'im_gespraech', 'bestellt', 'kein_interesse'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const adminCheck = await requireAdmin(event, payload);
  if (!adminCheck.ok) return adminCheck.response;

  try {
    if (event.httpMethod === 'GET') {
      const [partners, leads] = await Promise.all([
        pgrest('c9_partners', { query: 'select=slug,name,whatsapp,active,created_at&order=created_at.asc' }),
        pgrest('c9_leads', { query: 'select=id,partner_slug,name,phone,email,answers,status,wa_clicked_at,friend_shared_at,ordered_at,created_at,consent_text&order=created_at.desc&limit=2000' }),
      ]);
      const count = (arr) => ({
        umfragen: arr.filter((l) => !l.consent_text.startsWith('Manuell')).length,
        geschrieben: arr.filter((l) => l.wa_clicked_at).length,
        weitergeleitet: arr.filter((l) => l.friend_shared_at).length,
        im_gespraech: arr.filter((l) => l.status === 'im_gespraech').length,
        bestellt: arr.filter((l) => l.status === 'bestellt').length,
        kein_interesse: arr.filter((l) => l.status === 'kein_interesse').length,
      });
      const list = leads || [];
      return json(200, {
        goal: GOAL,
        totals: count(list),
        partners: (partners || []).map((p) => ({ ...p, ...count(list.filter((l) => l.partner_slug === p.slug)) })),
        leads: list.slice(0, 300).map((l) => ({
          id: l.id, partner: l.partner_slug, name: l.name, phone: l.phone, email: l.email,
          ziel: (l.answers && l.answers.labels && l.answers.labels.ziel) || '',
          start: (l.answers && l.answers.labels && l.answers.labels.start) || '',
          status: l.status, wa: !!l.wa_clicked_at, friend: !!l.friend_shared_at,
          manual: l.consent_text.startsWith('Manuell'), created_at: l.created_at,
        })),
      });
    }

    const p = payload;
    if (p.lead_id) {
      if (!UUID.test(p.lead_id) || !STATUS.includes(p.status)) return json(400, { error: 'Ungültig' });
      await pgrest('c9_leads', {
        method: 'PATCH',
        query: `id=eq.${p.lead_id}`,
        body: { status: p.status, ordered_at: p.status === 'bestellt' ? new Date().toISOString() : null },
      });
      return json(200, { ok: true });
    }
    if (p.manual) {
      const slug = clean(p.manual.partner_slug, 40);
      const name = clean(p.manual.name, 80);
      if (!SLUG.test(slug) || !name) return json(400, { error: 'Partnerin und Name angeben' });
      await pgrest('c9_leads', {
        method: 'POST',
        body: [{ partner_slug: slug, name, phone: 'manuell', answers: {}, status: 'bestellt', ordered_at: new Date().toISOString(), consent_text: 'Manuell eingetragen: Bestellung ohne Umfrage' }],
      });
      return json(200, { ok: true });
    }
    if (p.partner) {
      const slug = clean(p.partner.slug, 40).toLowerCase();
      const name = clean(p.partner.name, 60);
      const wa = clean(p.partner.whatsapp, 20).replace(/[^\d]/g, '').replace(/^00/, '');
      if (!SLUG.test(slug) || !name) return json(400, { error: 'Kurzname (nur a-z, 0-9, -) und Vorname angeben' });
      if (wa && wa.length < 9) return json(400, { error: 'WhatsApp-Nummer mit Ländervorwahl, z. B. 4366412345678' });
      await pgrest('c9_partners', {
        method: 'POST',
        query: 'on_conflict=slug',
        prefer: 'resolution=merge-duplicates',
        body: [{ slug, name, whatsapp: wa || null, active: p.partner.active !== false }],
      });
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('admin-road200', err.message, err.data || '');
    return json(500, { error: 'Road to 200 gerade nicht verfügbar. Ist supabase/neujahr-challenge.sql ausgeführt?' });
  }
};
