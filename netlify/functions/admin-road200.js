// netlify/functions/admin-road200.js
//
// Road to 200 (nur Admin): Zähler und Leads der Neujahrs-Umfrage.
// GET                                   -> { goal, totals, partners, leads }
// POST { lead_id, status }              -> Status ändern (neu, im_gespraech, bestellt, kein_interesse)
// POST { manual: { partner_slug, name } } -> Teilnehmerin ohne Umfrage als "bestellt" eintragen
// POST { partner: { slug, name, whatsapp, active } } -> Partnerin anlegen oder ändern (Link /neujahr/<slug>)
// POST { group_link }                  -> Link zur WhatsApp-Gruppe für "Ich bin dabei" (/dabei/<slug>)
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
        pgrest('c9_partners', { query: 'select=*&order=created_at.asc' }),
        pgrest('c9_leads', { query: 'select=*&order=created_at.desc&limit=2000' }),
      ]);
      const count = (arr) => ({
        umfragen: arr.filter((l) => l.answers && l.answers.ziel).length,
        selbst_eingetragen: arr.filter((l) => l.confirmed_at).length,
        geschrieben: arr.filter((l) => l.wa_clicked_at).length,
        weitergeleitet: arr.filter((l) => l.friend_shared_at).length,
        im_gespraech: arr.filter((l) => l.status === 'im_gespraech').length,
        bestellt: arr.filter((l) => l.status === 'bestellt').length,
        kein_interesse: arr.filter((l) => l.status === 'kein_interesse').length,
      });
      const list = leads || [];
      let groupLink = null;
      const videos = {};
      try {
        const st = (await pgrest('c9_settings', { query: 'key=in.(group_link,video_c9,video_beauty,video_energie,video_beratung)&select=key,value' })) || [];
        for (const r of st) {
          if (r.key === 'group_link') groupLink = r.value;
          else videos[r.key.replace('video_', '')] = r.value || '';
        }
      } catch (e) { groupLink = undefined; } // Tabelle fehlt noch
      // Adventskalender: anonyme Zahlen je Partnerin und Türchen
      let advent = null;
      try {
        const ev = (await pgrest('advent_events', { query: 'select=partner_slug,event,day&limit=50000' })) || [];
        const by = {};
        const doors = Array.from({ length: 24 }, () => 0);
        for (const e of ev) {
          const k = by[e.partner_slug] || (by[e.partner_slug] = { besuch: 0, tuerchen: 0, dabei: 0, quiz: 0, foto: 0, wunsch: 0, angebot: 0, beratung: 0, umfrage: 0 });
          k[e.event] = (k[e.event] || 0) + 1;
          if (e.event === 'tuerchen' && e.day) doors[e.day - 1]++;
        }
        advent = { byPartner: by, doors, total: ev.length };
      } catch (e) { advent = undefined; } // Tabelle fehlt noch
      return json(200, {
        goal: GOAL,
        advent,
        groupLink,
        videos,
        totals: count(list),
        partners: (partners || []).map((p) => ({ ...p, ...count(list.filter((l) => l.partner_slug === p.slug)) })),
        leads: list.slice(0, 300).map((l) => ({
          id: l.id, partner: l.partner_slug, name: l.name, phone: l.phone, email: l.email,
          ziel: (l.answers && l.answers.labels && l.answers.labels.ziel) || '',
          start: (l.answers && l.answers.labels && l.answers.labels.start) || '',
          status: l.status, wa: !!l.wa_clicked_at, friend: !!l.friend_shared_at,
          clicks: Array.isArray(l.clicks) ? l.clicks.map((c) => c && c.k).filter(Boolean) : [],
          manual: l.consent_text.startsWith('Manuell'), confirmed: !!l.confirmed_at, survey: !!(l.answers && l.answers.ziel), created_at: l.created_at,
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
    if (p.videos) {
      // Video-Links für die Auswertungsseite: YouTube, Vimeo oder direkte Videodatei (https)
      const rows = [];
      for (const k of ['c9', 'beauty', 'energie', 'beratung']) {
        if (p.videos[k] === undefined) continue;
        const v = clean(p.videos[k], 400);
        if (v && !/^https:\/\/[^\s]+$/.test(v)) return json(400, { error: 'Video-Links bitte vollständig mit https:// einfügen' });
        rows.push({ key: 'video_' + k, value: v || null, updated_at: new Date().toISOString() });
      }
      if (rows.length) await pgrest('c9_settings', { method: 'POST', query: 'on_conflict=key', prefer: 'resolution=merge-duplicates', body: rows });
      return json(200, { ok: true });
    }
    if (p.group_link !== undefined) {
      const link = clean(p.group_link, 300);
      if (link && !/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(link)) return json(400, { error: 'Bitte den Einladungslink der WhatsApp-Gruppe einfügen (https://chat.whatsapp.com/…)' });
      await pgrest('c9_settings', { method: 'POST', query: 'on_conflict=key', prefer: 'resolution=merge-duplicates', body: [{ key: 'group_link', value: link || null, updated_at: new Date().toISOString() }] });
      return json(200, { ok: true });
    }
    if (p.partner) {
      const slug = clean(p.partner.slug, 40).toLowerCase();
      const name = clean(p.partner.name, 60);
      // Nummer ins internationale Format: 0043… -> 43…, 0664… (ohne Ländervorwahl) -> 43664… (Österreich)
      const wa = clean(p.partner.whatsapp, 20).replace(/[^\d]/g, '').replace(/^00/, '').replace(/^0/, '43');
      if (!SLUG.test(slug) || !name) return json(400, { error: 'Kurzname (nur a-z, 0-9, -) und Vorname angeben' });
      if (wa && wa.length < 9) return json(400, { error: 'WhatsApp-Nummer mit Ländervorwahl, z. B. 4366412345678' });
      const row = { slug, name, whatsapp: wa || null, active: p.partner.active !== false };
      // Shop-Link und Instagram (supabase/neujahr-challenge.sql, Ergänzung): nur wenn mitgeschickt
      if (p.partner.shop_link !== undefined) {
        const shop = clean(p.partner.shop_link, 300);
        if (shop && !/^https:\/\/[^\s]+$/.test(shop)) return json(400, { error: 'Shop-Link bitte vollständig mit https:// einfügen' });
        row.shop_link = shop || null;
      }
      if (p.partner.instagram !== undefined) {
        // erlaubt: @name, name oder https://instagram.com/name
        const ig = clean(p.partner.instagram, 100).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?].*$/, '');
        if (ig && !/^[A-Za-z0-9._]{1,30}$/.test(ig)) return json(400, { error: 'Instagram-Name prüfen, z. B. @deinname' });
        row.instagram = ig || null;
      }
      try {
        await pgrest('c9_partners', { method: 'POST', query: 'on_conflict=slug', prefer: 'resolution=merge-duplicates', body: [row] });
      } catch (err) {
        if (err.data && err.data.code === 'PGRST204') return json(400, { error: 'Für Shop-Link und Instagram fehlt noch die SQL-Ergänzung.' });
        throw err;
      }
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('admin-road200', err.message, err.data || '');
    return json(500, { error: 'Road to 200 gerade nicht verfügbar. Ist supabase/neujahr-challenge.sql ausgeführt?' });
  }
};
