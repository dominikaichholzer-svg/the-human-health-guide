// netlify/functions/_lib/ranks.js
//
// Rang-Schwellen und Fortschritts-Berechnung für das Leader-Dashboard.
// Alle Zahlen und Daten sind fix (Stand der Forever-Qualifikationsregeln,
// wie von Dominik beschrieben) und bewusst hier hart codiert, nicht in der
// Datenbank, weil sie sich nicht pro Leader unterscheiden.
//
// Annahme (mit Dominik abgestimmt): "CC Stand" ist das CC-Volumen des
// laufenden Kalendermonats, setzt sich jeden Monat zurück. Der Fortschritt
// zur nächsten Rangstufe ist die Summe der letzten N Kalendermonate
// (rollierendes Fenster bis einschließlich heute), nicht zwingend exakt
// Forever's offizielle Zählweise für den Qualifikationszeitraum, aber eine
// sinnvolle Annäherung für die Dashboard-Anzeige.

const RANKS = ['supervisor', 'assistant_manager', 'manager', 'eagle_manager'];

const THRESHOLDS = {
  supervisor: { cc: 10, months: 1 },
  assistant_manager: { cc: 60, months: 2 },
  manager: { cc: 150, months: 4 },
};

const MANAGER_DEADLINE = '2027-04-30';
const EAGLE_WINDOW_START = '2027-05-01';
const EAGLE_WINDOW_END = '2028-04-30';
const EAGLE_TOTAL_CC_TARGET = 720;

const VIENNA_TZ = 'Europe/Vienna';

function viennaTodayStr() {
  // YYYY-MM-DD in Vienna-Lokalzeit, unabhängig davon wo der Server (UTC) läuft
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VIENNA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

function monthKey(dateStr) {
  // '2026-10-05' -> '2026-10'
  return String(dateStr).slice(0, 7);
}

function monthsBack(dateStr, n) {
  // Liste der letzten n Monats-Keys inkl. des Monats von dateStr, älteste zuerst
  const [y, m] = dateStr.split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function daysBetween(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00Z');
  const to = new Date(toStr + 'T00:00:00Z');
  return Math.round((to - from) / 86400000);
}

// Höchster cc_stand je Kalendermonat aus den wöchentlichen Einträgen
function monthlyTotals(weeklyEntries) {
  const totals = {};
  for (const e of weeklyEntries) {
    if (e.cc_stand == null) continue;
    const key = monthKey(e.week_start);
    const val = Number(e.cc_stand);
    if (!(key in totals) || val > totals[key]) totals[key] = val;
  }
  return totals;
}

function sumMonths(totals, keys) {
  return keys.reduce((sum, k) => sum + (totals[k] || 0), 0);
}

function computeProgress(leader, weeklyEntries) {
  const today = viennaTodayStr();
  const totals = monthlyTotals(weeklyEntries || []);

  if (leader.current_rank === 'eagle_manager') {
    return {
      currentRank: 'eagle_manager',
      status: 'qualified',
      message: 'Eagle Manager bereits erreicht.',
    };
  }

  if (leader.current_rank === 'manager') {
    if (today < EAGLE_WINDOW_START) {
      return {
        currentRank: 'manager',
        nextRank: 'eagle_manager',
        status: 'waiting_for_window',
        daysUntilEagleStart: daysBetween(today, EAGLE_WINDOW_START),
        eagleWindowStart: EAGLE_WINDOW_START,
        eagleWindowEnd: EAGLE_WINDOW_END,
      };
    }
    const keys = [];
    let cursor = EAGLE_WINDOW_START.slice(0, 7);
    const endKey = (today < EAGLE_WINDOW_END ? today : EAGLE_WINDOW_END).slice(0, 7);
    while (cursor <= endKey) {
      keys.push(cursor);
      const [y, m] = cursor.split('-').map(Number);
      const next = new Date(Date.UTC(y, m, 1));
      cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    const ccSoFar = sumMonths(totals, keys);
    return {
      currentRank: 'manager',
      nextRank: 'eagle_manager',
      status: 'in_progress',
      ccSoFar,
      ccTarget: EAGLE_TOTAL_CC_TARGET,
      progressPct: Math.min(100, Math.round((ccSoFar / EAGLE_TOTAL_CC_TARGET) * 100)),
      eagleWindowStart: EAGLE_WINDOW_START,
      eagleWindowEnd: EAGLE_WINDOW_END,
      daysUntilWindowEnd: daysBetween(today, EAGLE_WINDOW_END),
      newCC: 'manuell prüfen',
      newSupervisorLines: 'manuell prüfen',
      lbqEveryMonth: 'manuell prüfen',
    };
  }

  // supervisor oder assistant_manager: noch auf dem Weg zum Manager
  const rankIndex = RANKS.indexOf(leader.current_rank);
  const nextRank = RANKS[rankIndex + 1];
  const threshold = THRESHOLDS[nextRank];
  const keys = monthsBack(today, threshold.months);
  const ccSoFar = sumMonths(totals, keys);

  return {
    currentRank: leader.current_rank,
    nextRank,
    status: 'in_progress',
    ccSoFar,
    ccTarget: threshold.cc,
    progressPct: Math.min(100, Math.round((ccSoFar / threshold.cc) * 100)),
    windowMonths: threshold.months,
    managerDeadline: MANAGER_DEADLINE,
    daysUntilManagerDeadline: daysBetween(today, MANAGER_DEADLINE),
  };
}

module.exports = {
  RANKS,
  THRESHOLDS,
  MANAGER_DEADLINE,
  EAGLE_WINDOW_START,
  EAGLE_WINDOW_END,
  EAGLE_TOTAL_CC_TARGET,
  VIENNA_TZ,
  viennaTodayStr,
  monthKey,
  monthsBack,
  daysBetween,
  monthlyTotals,
  sumMonths,
  computeProgress,
};
