// netlify/functions/_lib/incentive.js
//
// Incentives (supabase/incentives.sql): Fortschritt einer Leaderin, automatisch
// aus "Mein Team" und ihren Wochen-Einträgen berechnet.
//
//   Neugeschäft-CC : CC (team_member_cc) von Partnerinnen, die im Zeitraum neu
//                    gestartet sind (start_date, sonst Anlagedatum), in den Monaten des Levels
//   neue AS / S    : diese neuen Partnerinnen mit Rang ab Assistant Supervisor / Supervisor
//   aktiv          : eigener CC-Stand (max. Wochenwert im Monat) >= active_cc in jedem Monat
// FPC (VIP-Kundinnen) zählen nicht als Teampartner.

const { pgrest } = require('./supabase');

const RANK_ORDER = ['fpc', 'partner', 'assistant_supervisor', 'supervisor', 'assistant_manager', 'manager', 'eagle_manager'];
const rankIdx = (r) => RANK_ORDER.indexOf(r || 'partner');
const round3 = (n) => Math.round(n * 1000) / 1000;

function monthKeys(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > end) break;
    out.push(k);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// Sichtbar ab 14 Tage vor Start bis 14 Tage nach dem letzten Level-Ende
function lastDate(inc) {
  return (inc.levels || []).reduce((d, l) => (l.to && l.to > d ? l.to : d), String(inc.end_date));
}
function isVisible(inc, today) {
  if (!inc.active) return false;
  return daysBetween(today, String(inc.start_date)) <= 14 && daysBetween(lastDate(inc), today) <= 14;
}

async function loadLeaderData(leaderId) {
  const members = ((await pgrest('team_members', { query: `leader_id=eq.${leaderId}&select=id,name,rank,start_date,created_at` })) || [])
    .filter((m) => m.rank !== 'fpc');
  let cc = [];
  if (members.length) {
    cc = (await pgrest('team_member_cc', { query: `member_id=in.(${members.map((m) => m.id).join(',')})&select=member_id,month,cc` })) || [];
  }
  const weeks = (await pgrest('weekly_entries', { query: `leader_id=eq.${leaderId}&select=week_start,cc_stand&order=week_start.desc&limit=60` })) || [];
  const ownCc = {};
  for (const w of weeks) {
    if (w.cc_stand == null) continue;
    const k = String(w.week_start).slice(0, 7);
    ownCc[k] = Math.max(ownCc[k] || 0, Number(w.cc_stand));
  }
  return { members, cc, ownCc };
}

function evalLevel(level, inc, data, today, reachedMain) {
  const from = level.from || String(inc.start_date);
  const to = level.to || String(inc.end_date);
  const months = monthKeys(from, to);
  const startOf = (m) => String(m.start_date || m.created_at).slice(0, 10);
  // Neue Partnerinnen: ab Incentive-Start bis Ende dieses Levels
  const fresh = data.members.filter((m) => startOf(m) >= String(inc.start_date) && startOf(m) <= to);
  const freshIds = new Set(fresh.map((m) => m.id));
  const newCc = round3(data.cc
    .filter((r) => freshIds.has(r.member_id) && months.includes(String(r.month).slice(0, 7)))
    .reduce((s, r) => s + (Number(r.cc) || 0), 0));
  const asList = fresh.filter((m) => rankIdx(m.rank) >= rankIdx('assistant_supervisor'));
  const sList = fresh.filter((m) => rankIdx(m.rank) >= rankIdx('supervisor'));

  // Bonus: AS/S kommen zusätzlich zu denen des erreichten Haupt-Levels
  const baseAs = level.bonus && reachedMain ? Number(reachedMain.new_as) || 0 : 0;
  const baseS = level.bonus && reachedMain ? Number(reachedMain.new_s) || 0 : 0;
  const curMonth = today.slice(0, 7);
  const activeTarget = Number(level.active_cc) || 0;
  const activeMonths = months.map((k) => {
    const v = data.ownCc[k];
    const ok = activeTarget ? (v != null && v >= activeTarget) : true;
    const state = ok ? 'ok' : (k > curMonth ? 'future' : k === curMonth ? 'open' : 'missed');
    return { month: k, cc: v != null ? round3(v) : null, state };
  });

  const goals = [];
  if (Number(level.new_cc)) goals.push({ key: 'new_cc', label: 'Neugeschäft-CC', value: newCc, target: Number(level.new_cc) });
  if (Number(level.new_as)) goals.push({ key: 'new_as', label: 'neue Assistant Supervisor', value: asList.length, target: baseAs + Number(level.new_as), names: asList.map((m) => m.name) });
  if (Number(level.new_s)) goals.push({ key: 'new_s', label: level.bonus ? 'neue Supervisor (gesamt)' : 'neue Supervisor', value: sList.length, target: baseS + Number(level.new_s), names: sList.map((m) => m.name) });
  if (activeTarget) {
    const okCount = activeMonths.filter((m) => m.state === 'ok').length;
    goals.push({ key: 'active', label: `Monate mit ${activeTarget} CC aktiv`, value: okCount, target: months.length, months: activeMonths });
  }
  goals.forEach((g) => { g.ok = g.value >= g.target; });
  const missed = activeMonths.some((m) => m.state === 'missed');
  return {
    name: level.name,
    bonus: !!level.bonus,
    reward: level.reward || '',
    from, to,
    started: today >= from,
    ended: today > to,
    daysLeft: Math.max(0, daysBetween(today, to)),
    locked: !!level.bonus && !reachedMain,
    reached: goals.length > 0 && goals.every((g) => g.ok),
    missedActive: missed,
    newMembers: fresh.length,
    goals,
  };
}

function evalIncentive(inc, data, today) {
  const levels = inc.levels || [];
  const main = levels.filter((l) => !l.bonus).map((l) => ({ def: l, res: evalLevel(l, inc, data, today, null) }));
  // höchstes erreichtes Haupt-Level (für den Bonus)
  const reachedMain = [...main].reverse().find((x) => x.res.reached);
  const out = levels.map((l) => (l.bonus
    ? evalLevel(l, inc, data, today, reachedMain ? reachedMain.def : null)
    : main.find((x) => x.def === l).res));
  // Fokus: erstes noch nicht erreichtes Level, das noch läuft (Bonus erst, wenn freigeschaltet)
  let focus = out.findIndex((r) => !r.reached && !r.ended && !r.locked);
  if (focus < 0) focus = out.length - 1;
  return {
    id: inc.id,
    title: inc.title,
    subtitle: inc.subtitle || '',
    start: String(inc.start_date),
    end: String(inc.end_date),
    started: today >= String(inc.start_date),
    daysToStart: Math.max(0, daysBetween(today, String(inc.start_date))),
    levels: out,
    focus,
  };
}

async function visibleIncentives(today) {
  let rows = [];
  try {
    rows = (await pgrest('incentives', { query: 'active=is.true&order=start_date.asc&select=*' })) || [];
  } catch (e) { return []; } // Tabelle fehlt noch
  return rows.filter((i) => isVisible(i, today));
}

async function leaderIncentives(leaderId, today, incs) {
  const list = incs || (await visibleIncentives(today));
  if (!list.length) return [];
  const data = await loadLeaderData(leaderId);
  return list.map((inc) => evalIncentive(inc, data, today));
}

module.exports = { leaderIncentives, visibleIncentives, evalIncentive, loadLeaderData };
