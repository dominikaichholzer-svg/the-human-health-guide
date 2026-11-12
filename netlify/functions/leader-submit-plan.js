// netlify/functions/leader-submit-plan.js
//
// POST /.netlify/functions/leader-submit-plan
// Body: {
//   "token": "...",
//   "target_month": "2026-12-01",       // aktueller oder nächster Monat (1. des Monats)
//   "plan_cc": 12.5,
//   "sponsoring_cc": 4, "eigen_cc": 1.2,
//   "kunden_konzepte": { "whatsapp_event": 2, "testboxen": 3, ... },
//   "team_cc": 40
// }
//
// Speichert die Monatsplanung per Upsert (eine pro Leaderin und Monat).
// CC mit bis zu 3 Nachkommastellen, Komma wird als Dezimalzeichen akzeptiert.

const { pgrest } = require('./_lib/supabase');
const { viennaTodayStr } = require('./_lib/ranks');
const { planWindow } = require('./_lib/plan');

const KONZEPTE = ['whatsapp_event', 'wellness_abend', 'testboxen', 'lips_zahnpasta', 'c9', 'geschenke', 'sonstige'];

const cc = (v) => {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 && n < 1000000 ? Math.round(n * 1000) / 1000 : null;
};

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

  const { token, target_month } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }
  const w = planWindow(viennaTodayStr());
  if (target_month !== w.current && target_month !== w.next) {
    return { statusCode: 400, body: JSON.stringify({ error: 'target_month muss der aktuelle oder der nächste Monat sein' }) };
  }
  const planCc = cc(payload.plan_cc);
  if (planCc === null) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bitte trag deinen Plan in CC ein' }) };
  }

  const konzepte = {};
  const input = payload.kunden_konzepte && typeof payload.kunden_konzepte === 'object' ? payload.kunden_konzepte : {};
  for (const key of KONZEPTE) {
    const v = cc(input[key]);
    if (v !== null) konzepte[key] = v;
  }

  try {
    const leaders = await pgrest('leaders', { query: `token=eq.${encodeURIComponent(token)}&select=id` });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const saved = await pgrest('monthly_plans', {
      method: 'POST',
      query: 'on_conflict=leader_id,target_month',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [{
        leader_id: leaders[0].id,
        target_month,
        plan_cc: planCc,
        sponsoring_cc: cc(payload.sponsoring_cc),
        eigen_cc: cc(payload.eigen_cc),
        kunden_konzepte: konzepte,
        team_cc: cc(payload.team_cc),
        updated_at: new Date().toISOString(),
      }],
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, plan: saved && saved[0] }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
