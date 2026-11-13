// netlify/functions/admin-pins.js
//
// Monatlicher Leadership-Pin, Admin-Seite.
// GET ?month=2026-11                       -> je Leaderin: Kennzahlen, alle Pins (erfüllt/Fortschritt),
//                                             Vorschlag und schon vergebener Pin. Ohne month: Vormonat.
// POST { leader_id, month, pin_key, note }  -> Pin vergeben oder ändern (pin_key null = keinen Pin)

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');
const { PINS, PIN_BY_KEY, monthMetrics, evaluate, publicPin } = require('./_lib/pins');
const { monthsBack, viennaTodayStr } = require('./_lib/ranks');
const { dashboardUrl } = require('./_lib/pushlinks');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wählbar: laufender Monat (Vorschau) und die 3 Monate davor
function allowedMonths(today) {
  return monthsBack(today, 4).reverse(); // neueste zuerst
}

async function notify(leader, pin) {
  try {
    const { sendPush } = require('./_lib/webpush');
    const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
    for (const sub of subs || []) {
      try {
        await sendPush(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          { title: `${pin.emoji} Dein neuer Leadership-Pin`, body: `${pin.label}. Schau ihn dir an!`, url: dashboardUrl(leader) }
        );
      } catch (e) { /* einzelnes Gerät egal */ }
    }
  } catch (e) { /* Push ist Zugabe, darf die Vergabe nicht verhindern */ }
}

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Ungültiges JSON' });
    }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const adminCheck = await requireAdmin(event, payload);
  if (!adminCheck.ok) return adminCheck.response;

  const today = viennaTodayStr();
  const months = allowedMonths(today);

  try {
    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const month = months.includes(q.month) ? q.month : months[1];
      const leaders = (await pgrest('leaders', { query: 'select=id,name&order=sort_order.asc' })) || [];
      const awarded = (await pgrest('leader_pins', { query: `month=eq.${month}-01&select=*` })) || [];
      const awardedBy = Object.fromEntries(awarded.map((r) => [r.leader_id, r]));
      const out = [];
      for (const l of leaders) {
        const metrics = await monthMetrics(l.id, month, today);
        const ev = evaluate(metrics);
        out.push({ id: l.id, name: l.name, metrics, pins: ev.results, proposal: ev.proposal ? ev.proposal.key : null, awarded: awardedBy[l.id] ? publicPin(awardedBy[l.id]) : null });
      }
      return json(200, { month, months, isCurrentMonth: month === months[0], catalog: PINS.map((p) => ({ key: p.key, emoji: p.emoji, label: p.label, rule: p.rule })), leaders: out });
    }

    const p = payload;
    if (!p.leader_id || !UUID.test(p.leader_id)) return json(400, { error: 'leader_id fehlt' });
    if (!months.slice(1).includes(p.month)) return json(400, { error: 'Pins gibt es für abgeschlossene Monate (die letzten 3).' });
    const leaders = await pgrest('leaders', { query: `id=eq.${p.leader_id}&select=*` });
    const leader = leaders && leaders[0];
    if (!leader) return json(404, { error: 'Nicht gefunden' });

    if (!p.pin_key) {
      await pgrest('leader_pins', { method: 'DELETE', query: `leader_id=eq.${leader.id}&month=eq.${p.month}-01` });
      return json(200, { ok: true, removed: true });
    }
    const pin = PIN_BY_KEY[p.pin_key];
    if (!pin) return json(400, { error: 'Unbekannter Pin' });

    // Begründung aus den Kennzahlen festhalten (bleibt auch, wenn sich Daten später ändern)
    const ev = evaluate(await monthMetrics(leader.id, p.month, today));
    const r = ev.results.find((x) => x.key === pin.key);
    const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim().slice(0, 1000) : null;
    const existing = await pgrest('leader_pins', { query: `leader_id=eq.${leader.id}&month=eq.${p.month}-01&select=pin_key` });
    const isNewPin = !existing || !existing[0] || existing[0].pin_key !== pin.key;

    await pgrest('leader_pins', {
      method: 'POST',
      query: 'on_conflict=leader_id,month',
      prefer: 'resolution=merge-duplicates',
      body: [Object.assign(
        { leader_id: leader.id, month: p.month + '-01', pin_key: pin.key, reason: r && r.reason ? r.reason : null, note },
        isNewPin ? { awarded_at: new Date().toISOString(), seen_at: null } : {}
      )],
    });
    if (isNewPin) await notify(leader, pin);
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-pins', err.message, err.data || '');
    return json(500, { error: 'Pins gerade nicht verfügbar.' });
  }
};
