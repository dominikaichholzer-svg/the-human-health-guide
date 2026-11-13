// netlify/functions/_lib/leader-context.js
//
// Was JARVIS im Chat über die angemeldete Leaderin weiß: ihre eigenen Zahlen
// und ihr Team ("Mein Team" mit CC, Zielen, Hinweisen und ihren Coaching-
// Notizen). Immer nur die Daten DIESER Leaderin. Fehlt eine Tabelle, wird
// der Teil einfach weggelassen.
//
// Dazu planStatus(): liegt sie hinter ihrem Monatsplan? (auch für die
// Warnung am 10. und 20., scheduled-plan-warning.js)

const { pgrest } = require('./supabase');
const { computeProgress, monthlyTotals, viennaTodayStr } = require('./ranks');
const { loadTeams } = require('./team');
const { memberSignals } = require('./signals');
const { leaderChallenge } = require('./challenge');
const { monthMetrics, evaluate } = require('./pins');

const RANK_DE = { partner: 'Partnerin (noch kein Rang)', supervisor: 'Supervisor', assistant_manager: 'Assistant Manager', manager: 'Manager', eagle_manager: 'Eagle Manager' };
const fmt = (n) => Number(n).toLocaleString('de-AT', { maximumFractionDigits: 3 });
const safe = async (p, fallback) => { try { return await p; } catch (e) { return fallback; } };

function daysInMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Hinter dem Plan = weniger als 85 % von dem, was nach den vergangenen Tagen anteilig dran wäre
function planStatus(planCc, ccSoFar, today) {
  if (!(planCc > 0)) return null;
  const day = Number(today.slice(8, 10));
  const dim = daysInMonth(today);
  const cc = Number(ccSoFar) || 0;
  const expected = (planCc * day) / dim;
  return {
    planCc,
    ccSoFar: cc,
    remaining: Math.max(0, Math.round((planCc - cc) * 1000) / 1000),
    daysLeft: dim - day,
    expected: Math.round(expected * 1000) / 1000,
    behind: cc < expected * 0.85,
    reached: cc >= planCc,
  };
}

async function buildLeaderContext(leader, todayStr) {
  const today = todayStr || viennaTodayStr();
  const monthKey = today.slice(0, 7);
  const lines = [];
  lines.push(`Heute: ${today}. Daten von ${leader.name} (Rang: ${RANK_DE[leader.current_rank] || leader.current_rank}). Nur ihre eigenen Daten, nichts von anderen Leaderinnen.`);

  const weeks = (await safe(pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=10&select=*` }), [])) || [];
  const progress = computeProgress(leader, weeks);
  if (progress.status === 'in_progress' && progress.ccTarget) {
    lines.push(`Rangweg: ${fmt(progress.ccSoFar || 0)} von ${progress.ccTarget} CC bis ${RANK_DE[progress.nextRank] || progress.nextRank}.`);
  }

  const plans = (await safe(pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=eq.${monthKey}-01&select=*` }), [])) || [];
  const plan = plans[0];
  const totals = monthlyTotals(weeks);
  const ccNow = totals[monthKey];
  let status = null;
  if (plan) {
    status = planStatus(Number(plan.plan_cc), ccNow, today);
    lines.push(`Monatsplan ${monthKey}: ${fmt(plan.plan_cc)} CC (Sponsern ${fmt(plan.sponsoring_cc || 0)}, Eigenverbrauch ${fmt(plan.eigen_cc || 0)}, Kunden ${fmt(plan.kunden_cc || 0)}${plan.kunden_text ? `, Konzept: ${String(plan.kunden_text).slice(0, 300)}` : ''}; Team-Ziel ${fmt(plan.team_cc || 0)} CC).`);
    lines.push(`Stand: ${ccNow != null ? fmt(ccNow) : 'noch kein'} CC im Monat (laut Wocheneintrag), noch ${status.daysLeft} Tage. ${status.reached ? 'Plan erreicht.' : status.behind ? `Liegt hinter dem Plan: anteilig wären ${fmt(status.expected)} CC dran, es fehlen noch ${fmt(status.remaining)} CC.` : 'Im Plan.'}`);
  } else {
    lines.push(`Für ${monthKey} gibt es noch keine Monatsplanung.`);
  }

  const days = (await safe(pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=gte.${monthKey}-01&order=entry_date.desc&select=entry_date,kontakte_heute,verkaeufe_heute,stimmung,schwer,morgen` }), [])) || [];
  if (days.length) {
    const k = days.reduce((a, d) => a + (Number(d.kontakte_heute) || 0), 0);
    const v = days.reduce((a, d) => a + (Number(d.verkaeufe_heute) || 0), 0);
    lines.push(`Tagesabschlüsse diesen Monat: ${days.length}, zusammen ${k} neue Kontakte und ${fmt(v)} CC Verkäufe. Letzter: ${days[0].entry_date}${days[0].schwer ? `, schwierig war: "${String(days[0].schwer).slice(0, 200)}"` : ''}${days[0].morgen ? `, Plan für morgen: "${String(days[0].morgen).slice(0, 200)}"` : ''}.`);
  } else {
    lines.push('Diesen Monat noch kein Tagesabschluss.');
  }
  const lw = weeks[0];
  if (lw) lines.push(`Letzte Woche (${lw.week_start}): ${lw.kontakte_gesamt ?? '–'} Kontakte, ${lw.geschaeftspraesentationen_versendet ?? '–'} Präsentationen, ${lw.nachgefasst ?? '–'} nachgefasst.`);

  const ch = await safe(leaderChallenge(leader.id, today), null);
  if (ch && ch.weekNo >= 1 && ch.weekNo <= ch.weeks && ch.content) {
    lines.push(`Leadership-Challenge Woche ${ch.weekNo}: Aufgabe "${String(ch.content.aufgabe || '').slice(0, 300)}" (${ch.progress && ch.progress.task_done ? 'erledigt' : 'offen'}).`);
  }

  const pinEval = await safe(monthMetrics(leader.id, monthKey, today).then(evaluate), null);
  if (pinEval) {
    lines.push('Leadership-Pins diesen Monat: ' + pinEval.results.map((r) => `${r.label} ${r.ok ? 'erreicht' : r.target != null ? `${fmt(r.value || 0)}/${fmt(r.target)}` : 'offen'}`).join(', ') + '.');
  }

  const teams = await safe(loadTeams([leader.id], today, { coaching: true }), null);
  const members = teams ? teams.byLeader[leader.id].members.filter((m) => m.active) : [];
  if (members.length) {
    const byId = Object.fromEntries(members.map((m) => [m.id, m]));
    lines.push(`Ihr Team (${members.length} aktiv, CC-Monat ${teams.ccMonth}):`);
    for (const m of members) {
      const sig = memberSignals(m, teams.ccMonth, today);
      const cc = teams.months.slice(-3).map((k) => `${k}: ${m.cc[k] != null ? fmt(m.cc[k]) : '–'}`).join(', ');
      const goals = (m.goals || []).filter((g) => g.status === 'open').map((g) => `${g.goal}${g.targetDate ? ' bis ' + g.targetDate : ''}${g.progress ? ` (${g.progress.pct} %)` : ''}${g.nextStep ? `, nächster Schritt: ${g.nextStep}` : ''}`);
      const notes = (m.notes || []).slice(0, 3).map((n) => `${String(n.createdAt).slice(0, 10)}: ${String(n.note).slice(0, 300)}`);
      lines.push(`- ${m.name} (${RANK_DE[m.rank] || m.rank}${m.sponsorId && byId[m.sponsorId] ? `, gesponsert von ${byId[m.sponsorId].name}` : ''}${m.startDate ? `, dabei seit ${m.startDate}` : ''}). CC ${cc}.${m.warum ? ` Warum: ${String(m.warum).slice(0, 200)}.` : ''}${m.onboarding && m.onboarding.done < 7 ? ` Einarbeitung ${m.onboarding.done}/7.` : ''}${goals.length ? ` Ziele: ${goals.join('; ')}.` : ''}${sig.length ? ` Hinweise: ${sig.map((x) => x.text).join('; ')}.` : ''}${notes.length ? ` Ihre Notizen: ${notes.join(' | ')}` : ''}`);
    }
  } else {
    lines.push('In "Mein Team" ist noch niemand eingetragen.');
  }
  return { text: lines.join('\n'), planStatus: status };
}

module.exports = { buildLeaderContext, planStatus, daysInMonth };
