// netlify/functions/leader-submit-plan.js
//
// POST /.netlify/functions/leader-submit-plan
// Body: {
//   "token": "...",
//   "target_month": "2026-12-01",       // aktueller oder nächster Monat (1. des Monats)
//   "plan_cc": 12.5,
//   "sponsoring_cc": 4, "eigen_cc": 1.2,
//   "kunden_cc": 6.5,
//   "kunden_text": "3 CC Testboxen, 2 CC WhatsApp-Event, 1,5 CC C9",
//   "team_cc": 40
// }
//
// Speichert die Monatsplanung per Upsert (eine pro Leaderin und Monat).
// CC mit bis zu 3 Nachkommastellen, Komma wird als Dezimalzeichen akzeptiert.

const { pgrest } = require('./_lib/supabase');
const { requireLeader } = require('./_lib/auth');
const { viennaTodayStr } = require('./_lib/ranks');
const { planWindow } = require('./_lib/plan');

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
  const w = planWindow(viennaTodayStr());
  if (target_month !== w.current && target_month !== w.next) {
    return { statusCode: 400, body: JSON.stringify({ error: 'target_month muss der aktuelle oder der nächste Monat sein' }) };
  }
  const planCc = cc(payload.plan_cc);
  if (planCc === null) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Bitte trag deinen Plan in CC ein' }) };
  }

  const kundenText = typeof payload.kunden_text === 'string' && payload.kunden_text.trim()
    ? payload.kunden_text.trim().slice(0, 3000)
    : null;

  try {
    const auth = await requireLeader(event, payload);
    if (!auth.ok) return auth.response;
    const leaders = [auth.leader];
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
        kunden_cc: cc(payload.kunden_cc),
        kunden_text: kundenText,
        team_cc: cc(payload.team_cc),
        updated_at: new Date().toISOString(),
      }],
    });
    return { statusCode: 200, body: JSON.stringify({ success: true, plan: saved && saved[0] }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
