// netlify/functions/_lib/challenge.js
//
// 52-Wochen-Leadership-Challenge. Woche 1 beginnt am Montag 30.11.2026,
// jede Woche läuft Montag bis Sonntag (Wiener Datum).
// Leaderinnen sehen nur Wochen, die schon begonnen haben (kein Vorauslesen).

const { pgrest } = require('./supabase');
const { daysBetween } = require('./ranks');

const START = '2026-11-30';
const WEEKS = 52;

// 0 = noch nicht gestartet, 1..52 = laufende Woche, 53 = vorbei
function weekNoFor(dateStr) {
  const d = daysBetween(START, dateStr);
  if (d < 0) return 0;
  return Math.min(WEEKS + 1, Math.floor(d / 7) + 1);
}

function weekStartOf(n) {
  const d = new Date(START + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7 * (n - 1));
  return d.toISOString().slice(0, 10);
}

// Serie: Wochen in Folge mit erledigter Aufgabe. Die laufende Woche zählt mit,
// sobald sie erledigt ist; ist sie noch offen, bricht sie die Serie nicht ab
// (bis Sonntag ist Zeit). Eine verpasste Woche setzt die Serie auf 0.
function streakOf(doneWeekNos, currentWeekNo) {
  const done = new Set(doneWeekNos);
  let n = done.has(currentWeekNo) ? currentWeekNo : currentWeekNo - 1;
  let streak = 0;
  while (n >= 1 && done.has(n)) { streak++; n--; }
  return streak;
}

// Was die Leaderin auf ihrem Dashboard braucht
async function leaderChallenge(leaderId, todayStr) {
  const weekNo = weekNoFor(todayStr);
  const out = { startDate: START, weeks: WEEKS, weekNo, weekStart: null, content: null, progress: null, prevWeek: null, doneCount: 0, streak: 0 };
  if (weekNo < 1 || weekNo > WEEKS) return out;
  out.weekStart = weekStartOf(weekNo);
  const nos = weekNo > 1 ? `${weekNo - 1},${weekNo}` : `${weekNo}`;
  const [content, progress, doneRows] = await Promise.all([
    pgrest('challenge_weeks', { query: `week_no=in.(${nos})&select=week_no,impuls,aufgabe,frage` }),
    pgrest('challenge_progress', { query: `leader_id=eq.${leaderId}&week_no=in.(${nos})&select=week_no,task_done,answer` }),
    pgrest('challenge_progress', { query: `leader_id=eq.${leaderId}&task_done=eq.true&select=week_no` }),
  ]);
  const c = Object.fromEntries((content || []).map((r) => [r.week_no, r]));
  const p = Object.fromEntries((progress || []).map((r) => [r.week_no, r]));
  const hasContent = (r) => r && (r.impuls || r.aufgabe || r.frage);
  out.content = hasContent(c[weekNo]) ? c[weekNo] : null;
  out.progress = p[weekNo] || null;
  out.doneCount = (doneRows || []).length;
  out.streak = streakOf((doneRows || []).map((r) => r.week_no), weekNo);
  // Vorwoche zum Nachholen, falls die Aufgabe noch offen ist
  if (weekNo > 1 && hasContent(c[weekNo - 1]) && !(p[weekNo - 1] && p[weekNo - 1].task_done)) {
    out.prevWeek = { weekNo: weekNo - 1, content: c[weekNo - 1], progress: p[weekNo - 1] || null };
  }
  return out;
}

module.exports = { START, WEEKS, weekNoFor, weekStartOf, leaderChallenge, streakOf };
