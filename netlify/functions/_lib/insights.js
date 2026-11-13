// netlify/functions/_lib/insights.js
//
// "JARVIS ist aufgefallen …": höchstens EINE proaktive Erkenntnis pro Woche und Leaderin.
//   1. Trends über die letzten 3 abgeschlossenen Monate werden REIN RECHNERISCH erkannt:
//      Ziel wiederholt verfehlt, CC stagniert, CC oder Aktivität steigt oder sinkt,
//      Challenge-Serie, Entwicklungsplan komplett umgesetzt.
//   2. Nur wenn es so eine belegte Auffälligkeit gibt, formuliert JARVIS daraus eine
//      Erkenntnis mit Beleg, einer Frage zum Selbstführen und einem kleinen Schritt.
//      Keine Auffälligkeit = keine Karte. Nichts wird erfunden.
//   3. Die Leaderin sieht sie im Überblick (kein Push) und tippt "Erledigt" oder "Nicht jetzt".
//      Dominik sieht sie im Admin-Dashboard und gebündelt im Montags-Briefing.
// Dominiks vertrauliche Notizen fließen hier bewusst NICHT ein, weil die Leaderin den Text sieht.

const { pgrest } = require('./supabase');
const { viennaTodayStr, monthsBack, monthlyTotals } = require('./ranks');
const challenge = require('./challenge');

const MODEL = 'claude-sonnet-5-5';
const KINDS = ['positiv', 'stagnation', 'ziel_verfehlt', 'aktivitaet'];

const INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    art: { type: 'string', enum: [...KINDS, 'keine'], description: 'Welche der erkannten Auffälligkeiten du nimmst, oder "keine"' },
    titel: { type: 'string', description: 'Kurz, max. 8 Wörter, z. B. "Deine Kontakte wachsen seit 3 Monaten"' },
    text: { type: 'string', description: '2 bis 3 Sätze in Du-Form mit konkretem Beleg (Zahlen, Monate)' },
    frage: { type: 'string', description: 'EINE offene Frage, mit der sie selbst die Ursache oder den Hebel findet' },
    vorschlag: { type: 'string', description: 'EIN kleiner, konkreter Schritt für diese Woche' },
  },
  required: ['art', 'titel', 'text', 'frage', 'vorschlag'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, Entwicklungscoach im Forever-Living-Team von Dominik. Ziel: Jede Leaderin lernt, sich selbst zu führen, statt von einem Mentor abhängig zu sein.
Du bekommst rechnerisch erkannte Auffälligkeiten aus ihren letzten 3 Monaten. Wähle GENAU EINE davon und formuliere sie für die Leaderin.
Regeln:
- Nur was in den Auffälligkeiten und Zahlen steht. Nenne den Beleg (Monate, Zahlen). Erfinde keine Ursachen. Statt zu deuten, stell eine Frage.
- Wechsle ab: War die letzte Erkenntnis kritisch und es gibt eine positive, nimm die positive. Wiederhole nicht dasselbe Thema wie letzte Woche, außer die Zahlen haben sich deutlich verändert.
- Kritisches ehrlich, aber ohne Vorwurf und ohne Bewertung der Person. Positives konkret würdigen.
- Der Vorschlag ist eine Handlung, klein genug für diese Woche. Passt er zu ihrem Entwicklungsschwerpunkt, verbinde ihn damit.
- Passt keine Auffälligkeit sinnvoll, antworte mit art "keine".
- Keine Gesundheits- oder Einkommensversprechen. Deutsch, Du-Form, kurze Sätze, keine Bindestriche als Satzverbinder.`;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0 = Sonntag
  return addDays(dateStr, -((dow + 6) % 7));
}
// Die Erkenntnis gilt für die kommende Woche: Sonntagabend erstellt = ab Montag
function insightWeekFor(today) { return mondayOf(addDays(today, 1)); }

const round = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Zahlen je Monat (die letzten 3 abgeschlossenen + laufender)
async function trendInput(leader, todayStr) {
  const today = todayStr || viennaTodayStr();
  const months = monthsBack(today, 4); // älteste zuerst, letzter = laufender Monat
  const from = months[0] + '-01';
  const safe = async (p) => { try { return (await p) || []; } catch (e) { return []; } };
  const [weeks, days, plans, actuals, chal, devplans, past] = await Promise.all([
    safe(pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&week_start=gte.${from}&order=week_start.asc&select=*` })),
    safe(pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=gte.${from}&select=*` })),
    safe(pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=gte.${from}&select=target_month,plan_cc` })),
    safe(pgrest('monthly_actuals', { query: `leader_id=eq.${leader.id}&month=gte.${from}&select=*` })),
    safe(pgrest('challenge_progress', { query: `leader_id=eq.${leader.id}&task_done=eq.true&select=week_no` })),
    safe(pgrest('development_plans', { query: `leader_id=eq.${leader.id}&month=gte.${from}&select=month,status,focus,steps` })),
    safe(pgrest('jarvis_insights', { query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=4&select=week_start,kind,title,status` })),
  ]);
  const totals = monthlyTotals(weeks);
  const stats = months.map((k) => {
    const mw = weeks.filter((w) => String(w.week_start).slice(0, 7) === k);
    const md = days.filter((d) => String(d.entry_date).slice(0, 7) === k);
    const sum = (arr, f) => arr.reduce((a, x) => a + (Number(x[f]) || 0), 0);
    const plan = plans.find((p) => String(p.target_month).slice(0, 7) === k);
    const act = actuals.find((a) => String(a.month).slice(0, 7) === k);
    const dp = devplans.find((p) => String(p.month).slice(0, 7) === k);
    const steps = dp && Array.isArray(dp.steps) ? dp.steps : [];
    return {
      monat: k,
      plan_cc: plan ? Number(plan.plan_cc) : null,
      cc: totals[k] != null ? totals[k] : null,
      kontakte: Math.max(sum(md, 'kontakte_heute'), sum(mw, 'kontakte_gesamt')),
      praesentationen: sum(mw, 'geschaeftspraesentationen_versendet'),
      gespraeche: sum(md, 'gespraeche_heute'),
      neue_kundinnen: sum(md, 'neue_kunden_heute'),
      tagesabschluesse: md.length,
      wocheneintraege: mw.length,
      global_cc: act && act.global_cc != null ? Number(act.global_cc) : null,
      entwicklungsplan: dp && dp.status !== 'proposed' ? { schwerpunkt: dp.focus, schritte: steps.length, erledigt: steps.filter((s) => s.done).length } : null,
    };
  });
  const weekNo = challenge.weekNoFor(today);
  const streak = weekNo > 0 ? challenge.streakOf(chal.map((c) => c.week_no), weekNo) : 0;
  return { today, months, stats, streak, past };
}

// Rechnerische Auffälligkeiten. Nur abgeschlossene Monate mit echten Einträgen zählen.
function detectTrends(input) {
  const done = input.stats.slice(0, 3);
  const cur = input.stats[3];
  const active = (s) => s.wocheneintraege > 0 || s.tagesabschluesse > 0;
  const out = [];

  const missed = done.filter((s) => s.plan_cc != null && s.cc != null && s.cc < s.plan_cc);
  if (missed.length >= 2) {
    out.push({ art: 'ziel_verfehlt', text: `Monatsziel in ${missed.length} der letzten 3 Monate nicht erreicht: ${missed.map((s) => `${s.monat} ${round(s.cc)} von ${s.plan_cc} CC`).join(', ')}.` });
  }

  const ccMonths = done.filter((s) => s.cc != null && active(s));
  if (ccMonths.length === 3) {
    const vals = ccMonths.map((s) => s.cc);
    const max = Math.max(...vals), min = Math.min(...vals), mean = vals.reduce((a, b) => a + b, 0) / 3;
    if (vals[0] < vals[1] && vals[1] < vals[2]) {
      out.push({ art: 'positiv', text: `CC steigt 3 Monate in Folge: ${ccMonths.map((s) => `${s.monat} ${round(s.cc)}`).join(', ')}.` });
    } else if (mean > 0 && max - min <= Math.max(1, mean * 0.1)) {
      out.push({ art: 'stagnation', text: `CC seit 3 Monaten etwa gleich bei rund ${round(mean)} CC (${vals.map(round).join(', ')}).` });
    }
  }

  const [a, b, c] = done;
  if (active(a) && active(b) && active(c)) {
    const before = (a.kontakte + b.kontakte) / 2;
    if (before >= 5 && c.kontakte >= before * 1.3) out.push({ art: 'positiv', text: `Kontakte gestiegen: ${c.monat} ${c.kontakte}, davor im Schnitt ${round(before)}.` });
    if (before >= 5 && c.kontakte <= before * 0.7) out.push({ art: 'aktivitaet', text: `Kontakte gesunken: ${c.monat} ${c.kontakte}, davor im Schnitt ${round(before)}.` });
    const presBefore = (a.praesentationen + b.praesentationen) / 2;
    if (c.kontakte >= 20 && c.praesentationen <= Math.max(1, presBefore * 0.5)) out.push({ art: 'aktivitaet', text: `Viele Kontakte (${c.kontakte} in ${c.monat}), aber nur ${c.praesentationen} Präsentationen.` });
  }
  if (c && c.tagesabschluesse >= 15) out.push({ art: 'positiv', text: `${c.tagesabschluesse} Tagesabschlüsse im ${c.monat}, sehr regelmäßig.` });

  if (cur && cur.plan_cc && cur.cc != null && cur.cc >= cur.plan_cc) out.push({ art: 'positiv', text: `Monatsziel ${cur.monat} schon erreicht: ${round(cur.cc)} von ${cur.plan_cc} CC.` });
  if (input.streak >= 4) out.push({ art: 'positiv', text: `Leadership-Challenge ${input.streak} Wochen in Folge erledigt.` });
  const lastPlan = c && c.entwicklungsplan;
  if (lastPlan && lastPlan.schritte > 0 && lastPlan.erledigt === lastPlan.schritte) {
    out.push({ art: 'positiv', text: `Entwicklungsplan ${c.monat} ("${lastPlan.schwerpunkt}") komplett umgesetzt: alle ${lastPlan.schritte} Schritte.` });
  }
  return out;
}

async function insightFor(client, leader, todayStr, opts) {
  const o = opts || {};
  const input = await trendInput(leader, todayStr);
  const week = insightWeekFor(input.today);
  const existing = await pgrest('jarvis_insights', { query: `leader_id=eq.${leader.id}&week_start=eq.${week}&select=id,status` });
  if (existing && existing[0]) {
    if (!(o.force && existing[0].status === 'neu')) return { skipped: 'schon vorhanden' };
    await pgrest('jarvis_insights', { method: 'DELETE', query: `id=eq.${existing[0].id}` });
  }
  const trends = detectTrends(input);
  if (!trends.length) return { skipped: 'keine belegte Auffälligkeit' };

  const prompt = `Leaderin: ${leader.name}, Rang ${leader.current_rank}. Heute: ${input.today}.
Erkannte Auffälligkeiten:
${trends.map((t) => `- [${t.art}] ${t.text}`).join('\n')}
Zahlen je Monat (der letzte ist der laufende Monat):
${JSON.stringify(input.stats)}
Letzte Erkenntnisse (neueste zuerst): ${input.past.length ? JSON.stringify(input.past) : 'keine'}`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: INSIGHT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (res.content || []).find((x) => x.type === 'text');
  if (!block) throw new Error('Keine Antwort');
  const r = JSON.parse(block.text);
  if (!KINDS.includes(r.art)) return { skipped: 'JARVIS: nichts Passendes' };
  const row = {
    leader_id: leader.id,
    week_start: week,
    kind: r.art,
    title: String(r.titel).slice(0, 120),
    text: String(r.text).slice(0, 800),
    question: String(r.frage).slice(0, 300),
    suggestion: String(r.vorschlag).slice(0, 300),
    evidence: trends,
    status: 'neu',
  };
  await pgrest('jarvis_insights', { method: 'POST', query: 'on_conflict=leader_id,week_start', prefer: 'resolution=ignore-duplicates', body: [row] });
  return { created: r.art };
}

async function runInsights(client, leaders, todayStr, opts) {
  const results = [];
  for (const leader of leaders) {
    try {
      results.push({ leader: leader.name, ...(await insightFor(client, leader, todayStr, opts)) });
    } catch (err) {
      console.error('Erkenntnis', leader.name, err.message);
      results.push({ leader: leader.name, error: err.message });
    }
  }
  return results;
}

function publicInsight(r) {
  if (!r) return null;
  return { id: r.id, weekStart: String(r.week_start).slice(0, 10), kind: r.kind, title: r.title, text: r.text, question: r.question, suggestion: r.suggestion, status: r.status, createdAt: r.created_at };
}

// Die aktuelle Erkenntnis der Woche (egal welcher Status), oder null
async function currentInsight(leaderId, todayStr) {
  const today = todayStr || viennaTodayStr();
  const rows = await pgrest('jarvis_insights', { query: `leader_id=eq.${leaderId}&week_start=gte.${mondayOf(today)}&order=week_start.desc&limit=1&select=*` });
  return publicInsight(rows && rows[0]);
}

// Neueste Erkenntnis je Leaderin (für Dominik)
async function latestInsights(leaderIds) {
  if (!leaderIds.length) return {};
  const rows = await pgrest('jarvis_insights', { query: `leader_id=in.(${leaderIds.join(',')})&order=week_start.desc&limit=${leaderIds.length * 3}&select=*` });
  const out = {};
  for (const r of rows || []) if (!out[r.leader_id]) out[r.leader_id] = publicInsight(r);
  return out;
}

module.exports = { INSIGHT_SCHEMA, KINDS, mondayOf, insightWeekFor, trendInput, detectTrends, insightFor, runInsights, publicInsight, currentInsight, latestInsights };
