// netlify/functions/_lib/pins.js
//
// Monatlicher Leadership-Pin. HIER stehen alle Regeln an einer Stelle.
// Das System prüft am Monatsende jede Regel und schlägt den ersten erfüllten
// Pin in der Reihenfolge unten vor (Leadership vor Fleiß). Dominik bestätigt
// oder wählt einen anderen. Jede Leaderin sieht nur ihre eigenen Pins.

const { pgrest } = require('./supabase');
const { monthlyTotals, monthsBack, viennaTodayStr } = require('./ranks');
const { weekStartOf, WEEKS } = require('./challenge');

const fmt = (n) => Number(n).toLocaleString('de-AT', { maximumFractionDigits: 3 });

// Reihenfolge = Priorität beim Vorschlag
const PINS = [
  {
    key: 'team_builder', emoji: '🌱', label: 'Team-Builderin',
    rule: 'Mindestens 1 neue Partnerin mit gestarteter Einarbeitung im Monat',
    check: (m) => ({ ok: m.newPartners.length >= 1, value: m.newPartners.length, target: 1,
      reason: m.newPartners.length ? `Neue Partnerin${m.newPartners.length > 1 ? 'nen' : ''}: ${m.newPartners.join(', ')}` : '' }),
  },
  {
    key: 'team_growth', emoji: '📈', label: 'Team-Wachstum',
    rule: 'Global gesamt CC höher als im Vormonat',
    check: (m) => ({ ok: m.globalCc != null && m.globalCcPrev != null && m.globalCc > m.globalCcPrev, value: m.globalCc || 0, target: m.globalCcPrev != null ? m.globalCcPrev : null,
      reason: m.globalCc != null ? `Global gesamt ${fmt(m.globalCc)} CC${m.globalCcPrev != null ? `, im Vormonat ${fmt(m.globalCcPrev)}` : ''}` : '' }),
  },
  {
    key: 'plan_hero', emoji: '🎯', label: 'Plan-Erfüllerin',
    rule: 'Persönliche CC mindestens so hoch wie in der Monatsplanung geplant',
    check: (m) => ({ ok: m.planCc > 0 && m.personalCc != null && m.personalCc >= m.planCc, value: m.personalCc || 0, target: m.planCc || null,
      reason: m.planCc > 0 ? `${fmt(m.personalCc || 0)} CC erreicht, geplant waren ${fmt(m.planCc)}` : '' }),
  },
  {
    key: 'challenge_champion', emoji: '🔥', label: 'Challenge-Champion',
    rule: 'Alle Wochenaufgaben der Leadership-Challenge im Monat erledigt',
    check: (m) => ({ ok: m.challengeWeeks >= 1 && m.challengeDone >= m.challengeWeeks, value: m.challengeDone, target: m.challengeWeeks || null,
      reason: m.challengeWeeks ? `${m.challengeDone} von ${m.challengeWeeks} Wochenaufgaben erledigt` : '' }),
  },
  {
    key: 'consistency_queen', emoji: '👑', label: 'Queen of Consistency',
    rule: 'Tagesabschluss an mindestens 20 Tagen im Monat',
    check: (m) => ({ ok: m.dailyDays >= 20, value: m.dailyDays, target: 20, reason: `${m.dailyDays} Tagesabschlüsse` }),
  },
  {
    key: 'contact_queen', emoji: '💬', label: 'Kontakt-Königin',
    rule: 'Mindestens 200 neue Kontakte im Monat (10 pro Tag an 20 Tagen)',
    check: (m) => ({ ok: m.contacts >= 200, value: m.contacts, target: 200, reason: `${m.contacts} neue Kontakte` }),
  },
];
const PIN_BY_KEY = Object.fromEntries(PINS.map((p) => [p.key, p]));

function nextMonthKey(key) {
  const [y, mo] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Kennzahlen einer Leaderin für einen Monat ("2026-11"). Laufender Monat = Stand heute.
async function monthMetrics(leaderId, monthKey, todayStr) {
  const today = todayStr || viennaTodayStr();
  const from = monthKey + '-01';
  const to = nextMonthKey(monthKey) + '-01';
  const prevKey = monthsBack(from, 2)[0];

  const safe = async (p) => { try { return (await p) || []; } catch (e) { return []; } };
  const [days, weeks, plans, tps, actuals] = await Promise.all([
    safe(pgrest('daily_reflections', { query: `leader_id=eq.${leaderId}&entry_date=gte.${from}&entry_date=lt.${to}&select=entry_date,kontakte_heute` })),
    safe(pgrest('weekly_entries', { query: `leader_id=eq.${leaderId}&week_start=gte.${from}&week_start=lt.${to}&select=week_start,cc_stand,kontakte_gesamt` })),
    safe(pgrest('monthly_plans', { query: `leader_id=eq.${leaderId}&target_month=eq.${from}&select=plan_cc` })),
    safe(pgrest('new_tps', { query: `leader_id=eq.${leaderId}&created_at=gte.${from}&created_at=lt.${to}&select=tp_name` })),
    safe(pgrest('monthly_actuals', { query: `leader_id=eq.${leaderId}&month=in.(${prevKey}-01,${from})&select=*` })),
  ]);

  // Global gesamt CC aus dem Monatsabschluss (dieser Monat und Vormonat)
  let globalCc = null, globalCcPrev = null;
  for (const r of actuals) {
    if (r.global_cc == null) continue;
    if (String(r.month).slice(0, 7) === monthKey) globalCc = Number(r.global_cc);
    else globalCcPrev = Number(r.global_cc);
  }

  // Challenge-Wochen, die in diesem Monat begonnen haben (und schon begonnen haben)
  const weekNos = [];
  for (let n = 1; n <= WEEKS; n++) {
    const ws = weekStartOf(n);
    if (ws >= from && ws < to && ws <= today) weekNos.push(n);
  }
  let challengeDone = 0;
  if (weekNos.length) {
    const prog = await safe(pgrest('challenge_progress', { query: `leader_id=eq.${leaderId}&week_no=in.(${weekNos.join(',')})&task_done=eq.true&select=week_no` }));
    challengeDone = prog.length;
  }

  const dailyContacts = days.reduce((a, d) => a + (Number(d.kontakte_heute) || 0), 0);
  const weeklyContacts = weeks.reduce((a, w) => a + (Number(w.kontakte_gesamt) || 0), 0);
  const totals = monthlyTotals(weeks);
  return {
    month: monthKey,
    dailyDays: days.length,
    contacts: Math.max(dailyContacts, weeklyContacts),
    personalCc: totals[monthKey] != null ? totals[monthKey] : null,
    planCc: plans[0] && plans[0].plan_cc != null ? Number(plans[0].plan_cc) : 0,
    newPartners: tps.map((t) => t.tp_name),
    globalCc,
    globalCcPrev,
    challengeWeeks: weekNos.length,
    challengeDone,
  };
}

// Alle Pins mit erfüllt/Fortschritt + Vorschlag
function evaluate(metrics) {
  const results = PINS.map((p) => {
    const r = p.check(metrics);
    return { key: p.key, emoji: p.emoji, label: p.label, rule: p.rule, ok: !!r.ok, value: r.value, target: r.target, reason: r.reason };
  });
  const proposal = results.find((r) => r.ok) || null;
  return { results, proposal };
}

function publicPin(row) {
  const p = PIN_BY_KEY[row.pin_key] || { emoji: '⭐', label: row.pin_key };
  return { month: String(row.month).slice(0, 7), key: row.pin_key, emoji: p.emoji, label: p.label, reason: row.reason, note: row.note, awardedAt: row.awarded_at, seen: !!row.seen_at };
}

module.exports = { PINS, PIN_BY_KEY, monthMetrics, evaluate, publicPin, nextMonthKey };
