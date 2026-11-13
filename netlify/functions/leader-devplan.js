// netlify/functions/leader-devplan.js
//
// Persönlicher Entwicklungsplan der angemeldeten Leaderin.
// GET                                                        -> { current, next, pendingReview }
// POST { action:"confirm", month, focus, goal, steps:[text] } -> Vorschlag übernehmen oder angepasst bestätigen
// POST { action:"step", month, index, done?, note? }          -> Schritt abhaken / kurz notieren
// POST { action:"reflect", month, text }                      -> eigene Sicht zur Monatsauswertung

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { leaderPlans } = require('./_lib/devplan');
const { viennaTodayStr, monthsBack } = require('./_lib/ranks');
const { nextMonthStart } = require('./_lib/plan');

const clean = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

exports.handler = async function (event) {
  let p = null;
  if (event.httpMethod === 'POST') {
    try { p = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const auth = await requireLeader(event, p);
  if (!auth.ok) return auth.response;
  const leaderId = auth.leader.id;

  try {
    if (event.httpMethod === 'GET') return json(200, await leaderPlans(leaderId));

    const today = viennaTodayStr();
    const allowed = [monthsBack(today, 2)[0], today.slice(0, 7), nextMonthStart(today).slice(0, 7)];
    if (!allowed.includes(p.month)) return json(400, { error: 'Dieser Monat kann nicht geändert werden.' });
    const rows = await pgrest('development_plans', { query: `leader_id=eq.${leaderId}&month=eq.${p.month}-01&select=*` });
    const plan = rows && rows[0];
    if (!plan) return json(404, { error: 'Für diesen Monat gibt es noch keinen Entwicklungsplan.' });
    const q = `id=eq.${plan.id}&leader_id=eq.${leaderId}`;
    const now = new Date().toISOString();

    if (p.action === 'confirm') {
      if (plan.status === 'reviewed') return json(400, { error: 'Dieser Monat ist schon ausgewertet.' });
      const focus = clean(p.focus, 200), goal = clean(p.goal, 400);
      if (!focus || !goal) return json(400, { error: 'Bitte Schwerpunkt und Ziel ausfüllen.' });
      const texts = (Array.isArray(p.steps) ? p.steps : []).map((t) => clean(t, 300)).filter(Boolean).slice(0, 6);
      if (!texts.length) return json(400, { error: 'Bitte mindestens einen Schritt eintragen.' });
      const old = Array.isArray(plan.steps) ? plan.steps : [];
      // Schon abgehakte Schritte mit gleichem Text bleiben abgehakt
      const steps = texts.map((text) => { const o = old.find((s) => s.text === text); return { text, done: !!(o && o.done), note: o ? o.note || null : null }; });
      await pgrest('development_plans', { method: 'PATCH', query: q, body: { focus, goal, steps, status: 'confirmed', updated_at: now } });
      return json(200, { ok: true });
    }

    if (p.action === 'step') {
      if (plan.status !== 'confirmed') return json(400, { error: 'Bitte bestätige zuerst deinen Plan.' });
      const steps = Array.isArray(plan.steps) ? plan.steps.slice() : [];
      const i = Number(p.index);
      if (!Number.isInteger(i) || i < 0 || i >= steps.length) return json(400, { error: 'Ungültiger Schritt' });
      steps[i] = { ...steps[i] };
      if (p.done !== undefined) steps[i].done = !!p.done;
      if (p.note !== undefined) steps[i].note = clean(p.note, 500);
      await pgrest('development_plans', { method: 'PATCH', query: q, body: { steps, updated_at: now } });
      return json(200, { ok: true });
    }

    if (p.action === 'reflect') {
      if (!plan.review) return json(400, { error: 'Die Auswertung ist noch nicht da.' });
      const text = clean(p.text, 2000);
      if (!text) return json(400, { error: 'Bitte schreib kurz deine Sicht.' });
      await pgrest('development_plans', { method: 'PATCH', query: q, body: { leader_reflection: text, status: 'reviewed', updated_at: now } });
      return json(200, { ok: true });
    }

    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('leader-devplan', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
