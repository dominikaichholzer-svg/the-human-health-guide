// netlify/functions/_lib/signals.js
//
// Hinweise auf Coaching-Bedarf. Alle Regeln an einer Stelle.
//
// Zu Partnerinnen (sehen Leaderin und Dominik):
//   cc_drop        CC 2 Monate in Folge gesunken, oder unter 4 CC gefallen (Vormonat noch >= 4)
//   onboarding     Einarbeitung nicht fertig und seit 14 Tagen kein neuer Schritt
//   goal_due       offenes Ziel in höchstens 14 Tagen fällig (oder überfällig), Fortschritt unter 50 %
//
// Zu Leaderinnen (sieht nur Dominik):
//   contacts_no_presentations  viele Kontakte, kaum Präsentationen (letzte 4 Wochen)
//   no_daily                   seit 5 Tagen kein Tagesabschluss
//   plan_missed                Vormonat unter 80 % der geplanten CC

const { monthsBack, daysBetween, monthlyTotals } = require('./ranks');

const ACTIVE_CC = 4;
const STUCK_DAYS = 14;
const GOAL_WARN_DAYS = 14;

function memberSignals(m, ccMonth, today) {
  const out = [];
  if (!m.active) return out;
  const [m2, m1, m0] = monthsBack(ccMonth + '-01', 3);
  const c0 = m.cc[m0], c1 = m.cc[m1], c2 = m.cc[m2];
  if (c0 != null && c1 != null && c0 < ACTIVE_CC && c1 >= ACTIVE_CC) {
    out.push({ key: 'cc_drop', text: `Unter ${ACTIVE_CC} CC gefallen (${fmt(c1)} → ${fmt(c0)})` });
  } else if (c0 != null && c1 != null && c2 != null && c0 < c1 && c1 < c2) {
    out.push({ key: 'cc_drop', text: `CC sinkt seit 2 Monaten (${fmt(c2)} → ${fmt(c1)} → ${fmt(c0)})` });
  }
  const ob = m.onboarding;
  if (ob && ob.done < 7 && ob.lastActivity) {
    const days = daysBetween(String(ob.lastActivity).slice(0, 10), today);
    if (days >= STUCK_DAYS) out.push({ key: 'onboarding', text: `Einarbeitung seit ${days} Tagen ohne neuen Schritt (${ob.done}/7)` });
  }
  for (const g of m.goals || []) {
    if (g.status !== 'open' || !g.targetDate) continue;
    const left = daysBetween(today, g.targetDate);
    if (left > GOAL_WARN_DAYS) continue;
    const pct = g.progress ? g.progress.pct : null;
    if (pct != null && pct >= 50) continue;
    out.push({
      key: 'goal_due',
      text: (left < 0 ? `Ziel „${g.goal}" seit ${-left} Tagen überfällig` : `Ziel „${g.goal}" in ${left} Tagen fällig`) + (pct != null ? ` (${pct} %)` : ''),
    });
  }
  return out;
}

// weeks: weekly_entries (neueste zuerst), days: daily_reflections (neueste zuerst), plans: monthly_plans
function leaderSignals({ weeks, days, plans }, today) {
  const out = [];
  const recent = (weeks || []).filter((w) => daysBetween(w.week_start, today) <= 28);
  const contacts = recent.reduce((a, w) => a + (Number(w.kontakte_gesamt) || 0), 0);
  const pres = recent.reduce((a, w) => a + (Number(w.geschaeftspraesentationen_versendet) || 0), 0);
  if (contacts >= 40 && pres <= contacts * 0.05) {
    out.push({ key: 'contacts_no_presentations', text: `${contacts} Kontakte, aber nur ${pres} Präsentation${pres === 1 ? '' : 'en'} in 4 Wochen. Gespräch über den nächsten Schritt nach dem Kontakt?` });
  }
  const lastDay = (days || [])[0];
  if (lastDay) {
    const gap = daysBetween(lastDay.entry_date, today);
    if (gap >= 5) out.push({ key: 'no_daily', text: `Seit ${gap} Tagen kein Tagesabschluss` });
  }
  const prevKey = monthsBack(today, 2)[0];
  const plan = (plans || []).find((p) => String(p.target_month).slice(0, 7) === prevKey);
  const totals = monthlyTotals(weeks || []);
  if (plan && Number(plan.plan_cc) > 0 && totals[prevKey] != null && totals[prevKey] < Number(plan.plan_cc) * 0.8) {
    out.push({ key: 'plan_missed', text: `Plan im Vormonat verfehlt: ${fmt(totals[prevKey])} von ${fmt(plan.plan_cc)} CC` });
  }
  return out;
}

function fmt(n) {
  return Number(n).toLocaleString('de-AT', { maximumFractionDigits: 3 });
}

module.exports = { memberSignals, leaderSignals };
