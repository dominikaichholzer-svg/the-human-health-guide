// netlify/functions/_lib/plan.js
//
// Regeln zur Monatsplanung der Leaderinnen.
//
// Ab dem 25. eines Monats ist das Dashboard gesperrt, bis die Planung für den
// nächsten Monat abgegeben ist. Die Sperre läuft über den Monatswechsel
// hinweg bis zum 5., falls bis dahin noch keine Planung für den neuen
// Monat da ist. Dazwischen (6. bis 24.) ist nichts gesperrt, die Planung
// kann aber jederzeit angesehen und geändert werden.

function nextMonthStart(todayStr) {
  const [y, m] = todayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

function planWindow(todayStr) {
  const day = Number(todayStr.slice(8, 10));
  const current = todayStr.slice(0, 7) + '-01';
  const next = nextMonthStart(todayStr);
  let required = null;
  if (day >= 25) required = next;
  else if (day <= 5) required = current;
  return { day, current, next, required };
}

module.exports = { planWindow, nextMonthStart };
