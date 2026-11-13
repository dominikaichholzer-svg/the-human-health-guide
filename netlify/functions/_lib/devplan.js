// netlify/functions/_lib/devplan.js
//
// Persönlicher Entwicklungsplan (monatlich).
//   1. Vorschlag: JARVIS schlägt EINEN Schwerpunkt mit Ziel und 3 bis 4 Schritten vor.
//      Grundlage: Entwicklungsprofil, Daten der letzten Wochen, Auswertung des Vormonats.
//      Ab dem 25. für den nächsten Monat (zusammen mit der Monatsplanung), sonst für
//      den laufenden Monat, falls noch keiner existiert.
//   2. Die Leaderin bestätigt oder passt an, hakt Schritte ab, notiert kurz.
//   3. Auswertung: ab dem 25. bzw. in den ersten 5 Tagen danach schreibt JARVIS einen
//      Entwurf (erreicht, verbessert, nächster Schritt), sie ergänzt ihre Sicht.
// Dominik sieht alles und kann Feedback ergänzen. Seine Notizen landen nie im Plan.

const { pgrest } = require('./supabase');
const { viennaTodayStr, monthsBack } = require('./ranks');
const { nextMonthStart } = require('./plan');
const { gatherInput } = require('./profile');

const MODEL = 'claude-sonnet-5-5';

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    schwerpunkt: { type: 'string', description: 'EIN Entwicklungsschwerpunkt für den Monat, z. B. "Die Geschäftsmöglichkeit vorstellen"' },
    warum: { type: 'string', description: 'Warum gerade dieser, mit Beleg aus den Daten, ermutigend in Du-Form' },
    ziel: { type: 'string', description: 'Realistisches, überprüfbares Monatsziel in Du-Form' },
    schritte: { type: 'array', items: { type: 'string' }, description: '3 bis 4 konkrete Umsetzungsschritte in Du-Form' },
    schulung: { type: 'string', description: 'Passendes Academy-Video, falls eines passt, sonst leer' },
  },
  required: ['schwerpunkt', 'warum', 'ziel', 'schritte', 'schulung'],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    erreicht: { type: 'string', description: 'Was sie erreicht hat, mit Zahlen oder Belegen, Du-Form' },
    verbessert: { type: 'string', description: 'Was sich verbessert hat, Du-Form' },
    naechster_schritt: { type: 'string', description: 'Der nächste Entwicklungsschritt, Du-Form' },
  },
  required: ['erreicht', 'verbessert', 'naechster_schritt'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, Entwicklungscoach im Forever-Living-Team von Dominik. Ziel: Jede Leaderin lernt, sich selbst zu führen und andere zu entwickeln, statt von einem Mentor abhängig zu sein.
Regeln:
- Stütze dich nur auf die Daten. Nenne einen Beleg. Erfinde nichts. Sind die Daten dünn, wähle einen einfachen, grundlegenden Schwerpunkt und sag das ehrlich.
- EIN Schwerpunkt, konkret und machbar im Monat. Schritte sind Handlungen, keine Haltungen ("Biete 3 Menschen die Präsentation an", nicht "Sei mutiger").
- Passe die Tiefe an ihren Rang an (Supervisor: eigenes Geschäft und erste Partnerinnen; Assistant Manager und Manager: zusätzlich Partnerinnen entwickeln).
- Du-Form, warm, klar, ermutigend. Keine Bewertung der Person, keine Gesundheits- oder Einkommensversprechen.
- Dominiks vertrauliche Notizen darfst du zum Verständnis nutzen, aber nie zitieren oder erwähnen.
- Deutsch, kurze Sätze, keine Bindestriche als Satzverbinder.`;

function monthKeyOfDate(d) { return d.slice(0, 7); }

// Für welchen Monat ist gerade ein Vorschlag fällig?
function targetMonth(today) {
  return Number(today.slice(8, 10)) >= 25 ? nextMonthStart(today).slice(0, 7) : monthKeyOfDate(today);
}

// Welcher bestätigte Plan braucht jetzt eine Auswertung? (ab dem 25. der laufende, bis zum 5. der Vormonat)
function reviewMonth(today) {
  const day = Number(today.slice(8, 10));
  if (day >= 25) return monthKeyOfDate(today);
  if (day <= 5) return monthsBack(today, 2)[0];
  return null;
}

async function askJson(client, schema, prompt) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Keine Antwort');
  return JSON.parse(block.text);
}

async function proposeFor(client, leader, monthKey, today) {
  const input = await gatherInput(leader, today);
  const prevPlans = await pgrest('development_plans', { query: `leader_id=eq.${leader.id}&month=lt.${monthKey}-01&order=month.desc&limit=1&select=*` });
  const prev = prevPlans && prevPlans[0];
  const prompt = `Erstelle den Entwicklungsplan von ${leader.name} für ${monthKey}.
Entwicklungsprofil: ${input.previous ? JSON.stringify(input.previous.profil) : 'noch keins'}
Letzter Entwicklungsplan: ${prev ? JSON.stringify({ monat: String(prev.month).slice(0, 7), schwerpunkt: prev.focus || (prev.proposal || {}).schwerpunkt, schritte: prev.steps, auswertung: prev.review, ihre_sicht: prev.leader_reflection }) : 'keiner'}
Daten:
${input.text}`;
  const p = await askJson(client, PROPOSAL_SCHEMA, prompt);
  const steps = (p.schritte || []).slice(0, 4).map((text) => ({ text: String(text).slice(0, 300), done: false, note: null }));
  await pgrest('development_plans', {
    method: 'POST',
    query: 'on_conflict=leader_id,month',
    prefer: 'resolution=ignore-duplicates',
    body: [{ leader_id: leader.id, month: monthKey + '-01', status: 'proposed', proposal: p, focus: p.schwerpunkt, goal: p.ziel, steps }],
  });
  return p;
}

async function reviewFor(client, leader, plan, today) {
  const input = await gatherInput(leader, today);
  const prompt = `Werte den Entwicklungsplan von ${leader.name} für ${String(plan.month).slice(0, 7)} aus.
Schwerpunkt: ${plan.focus}
Ziel: ${plan.goal}
Schritte (mit erledigt und ihren Notizen): ${JSON.stringify(plan.steps)}
Daten der letzten Wochen:
${input.text}`;
  const r = await askJson(client, REVIEW_SCHEMA, prompt);
  await pgrest('development_plans', { method: 'PATCH', query: `id=eq.${plan.id}`, body: { review: r, updated_at: new Date().toISOString() } });
  return r;
}

// Täglicher Lauf: nur dort die KI fragen, wo wirklich etwas fällig ist
async function runDevplans(client, leaders, todayStr, opts) {
  const today = todayStr || viennaTodayStr();
  const o = opts || {};
  const results = [];
  for (const leader of leaders) {
    try {
      const tm = targetMonth(today);
      const existing = await pgrest('development_plans', { query: `leader_id=eq.${leader.id}&month=eq.${tm}-01&select=id,status` });
      if (o.force && existing && existing[0] && existing[0].status === 'proposed') {
        await pgrest('development_plans', { method: 'DELETE', query: `id=eq.${existing[0].id}` });
        existing.length = 0;
      }
      if (!existing || !existing.length) {
        await proposeFor(client, leader, tm, today);
        results.push({ leader: leader.name, proposed: tm });
      }
      const rm = reviewMonth(today);
      if (rm) {
        const rows = await pgrest('development_plans', { query: `leader_id=eq.${leader.id}&month=eq.${rm}-01&status=eq.confirmed&review=is.null&select=*` });
        if (rows && rows[0]) {
          await reviewFor(client, leader, rows[0], today);
          results.push({ leader: leader.name, reviewed: rm });
        }
      }
    } catch (err) {
      console.error('Entwicklungsplan', leader.name, err.message);
      results.push({ leader: leader.name, error: err.message });
    }
  }
  return results;
}

// Was die Leaderin sieht: laufender Monat + offener Vorschlag + offene Auswertung
function publicPlan(row) {
  if (!row) return null;
  return {
    month: String(row.month).slice(0, 7),
    status: row.status,
    focus: row.focus,
    goal: row.goal,
    why: row.proposal ? row.proposal.warum : null,
    training: row.proposal && row.proposal.schulung ? row.proposal.schulung : null,
    steps: Array.isArray(row.steps) ? row.steps : [],
    review: row.review || null,
    reflection: row.leader_reflection || null,
    coachFeedback: row.coach_feedback || null,
  };
}

async function leaderPlans(leaderId, todayStr) {
  const today = todayStr || viennaTodayStr();
  const months = [monthsBack(today, 2)[0], monthKeyOfDate(today), nextMonthStart(today).slice(0, 7)];
  const rows = await pgrest('development_plans', { query: `leader_id=eq.${leaderId}&month=in.(${months.map((m) => m + '-01').join(',')})&select=*` });
  const by = Object.fromEntries((rows || []).map((r) => [String(r.month).slice(0, 7), r]));
  const [prevK, curK, nextK] = months;
  const pendingReview = [prevK, curK].map((k) => by[k]).find((r) => r && r.status === 'confirmed' && r.review && !r.leader_reflection) || null;
  return {
    current: publicPlan(by[curK]),
    next: publicPlan(by[nextK]),
    pendingReview: publicPlan(pendingReview),
  };
}

module.exports = { PROPOSAL_SCHEMA, REVIEW_SCHEMA, targetMonth, reviewMonth, proposeFor, reviewFor, runDevplans, leaderPlans, publicPlan };
