// netlify/functions/_lib/team.js
//
// "Mein Team": Partnerinnen einer Leaderin, ihre CC pro Monat und der
// Rangfortschritt. Wird vom Leader-Dashboard (leader-team) und vom
// Admin-Dashboard (admin-get-overview) benutzt.
//
// Eintrage-Monat: Die CC werden mit der Monatsplanung eingetragen. Ab dem 25.
// gilt der laufende Monat (er ist fast vorbei), davor der Vormonat.

const { pgrest } = require('./supabase');
const { THRESHOLDS, monthsBack, viennaTodayStr } = require('./ranks');

const MEMBER_RANKS = ['partner', 'supervisor', 'assistant_manager', 'manager', 'eagle_manager'];
const NEXT_RANK = { partner: 'supervisor', supervisor: 'assistant_manager', assistant_manager: 'manager', manager: 'eagle_manager' };
const HISTORY_MONTHS = 6;
const STEP_KEYS = ['step_1', 'step_2', 'step_3', 'step_4', 'step_5', 'step_6', 'step_7'];

function ccMonthKey(todayStr) {
  const day = Number(todayStr.slice(8, 10));
  if (day >= 25) return todayStr.slice(0, 7);
  return monthsBack(todayStr, 2)[0];
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function memberProgress(rank, ccByMonth, refMonthKey) {
  if (rank === 'eagle_manager') return { done: true };
  const next = NEXT_RANK[rank] || 'supervisor';
  if (next === 'eagle_manager') return { nextRank: next, manual: true };
  const th = THRESHOLDS[next];
  const keys = monthsBack(refMonthKey + '-01', th.months);
  const sum = round3(keys.reduce((s, k) => s + (Number(ccByMonth[k]) || 0), 0));
  return { nextRank: next, ccSoFar: sum, ccTarget: th.cc, months: th.months, pct: Math.min(100, Math.round((sum / th.cc) * 100)) };
}

// Fortschritt eines Rang-Ziels (z. B. "manager"): CC im Qualifikationsfenster des Zielrangs
function rankGoalProgress(targetRank, ccByMonth, refMonthKey) {
  const th = THRESHOLDS[targetRank];
  if (!th) return null;
  const keys = monthsBack(refMonthKey + '-01', th.months);
  const sum = round3(keys.reduce((s, k) => s + (Number(ccByMonth[k]) || 0), 0));
  return { ccSoFar: sum, ccTarget: th.cc, months: th.months, pct: Math.min(100, Math.round((sum / th.cc) * 100)) };
}

// leaderIds: Array von uuids. Liefert { ccMonth, months, byLeader: { id: { members, totals } } }
// opts.coaching: zusätzlich Coaching-Notizen der Leaderinnen und Entwicklungsziele je Partnerin
async function loadTeams(leaderIds, todayStr, opts) {
  const o = opts || {};
  const today = todayStr || viennaTodayStr();
  const ccMonth = ccMonthKey(today);
  const months = monthsBack(ccMonth + '-01', HISTORY_MONTHS); // älteste zuerst
  const byLeader = {};
  for (const id of leaderIds) byLeader[id] = { members: [], totals: {} };
  if (!leaderIds.length) return { ccMonth, months, byLeader };

  const members = await pgrest('team_members', {
    // select=* : Profilfelder (start_date, warum) kommen aus supabase/phase3.sql und dürfen fehlen
    query: `leader_id=in.(${leaderIds.join(',')})&select=*&order=created_at.asc`,
  });
  const ids = (members || []).map((m) => m.id);
  let ccRows = [];
  if (ids.length) {
    ccRows = await pgrest('team_member_cc', {
      query: `member_id=in.(${ids.join(',')})&month=gte.${months[0]}-01&select=member_id,month,cc`,
    });
  }
  // Einarbeitungs-Checkliste (new_tps, verknüpft über member_id; Spalte aus
  // supabase/team-onboarding.sql). Fehlt sie noch, ohne Checklisten.
  const tpBy = {};
  if (ids.length) {
    try {
      const tps = await pgrest('new_tps', {
        query: `member_id=in.(${ids.join(',')})&select=*`,
      });
      for (const t of tps || []) {
        const steps = STEP_KEYS.map((k) => !!t[k]);
        tpBy[t.member_id] = { tpId: t.id, steps, done: steps.filter(Boolean).length, lastActivity: t.steps_updated_at || t.created_at || null };
      }
    } catch (e) { /* noch nicht eingerichtet */ }
  }
  // Coaching (supabase/phase3.sql): Notizen der Leaderinnen und Entwicklungsziele
  const notesBy = {}, goalsBy = {};
  let coachingReady = false;
  if (o.coaching && ids.length) {
    try {
      const [notes, goals] = await Promise.all([
        pgrest('coaching_notes', { query: `leader_id=in.(${leaderIds.join(',')})&author=eq.leader&order=created_at.desc&select=id,member_id,note,created_at` }),
        pgrest('member_goals', { query: `leader_id=in.(${leaderIds.join(',')})&order=created_at.asc&select=*` }),
      ]);
      for (const n of notes || []) (notesBy[n.member_id] = notesBy[n.member_id] || []).push({ id: n.id, note: n.note, createdAt: n.created_at });
      for (const g of goals || []) (goalsBy[g.member_id] = goalsBy[g.member_id] || []).push(g);
      coachingReady = true;
    } catch (e) { /* noch nicht eingerichtet */ }
  }
  const ccBy = {};
  for (const r of ccRows || []) {
    (ccBy[r.member_id] = ccBy[r.member_id] || {})[String(r.month).slice(0, 7)] = Number(r.cc);
  }
  for (const m of members || []) {
    const cc = ccBy[m.id] || {};
    const entry = {
      id: m.id,
      name: m.name,
      sponsorId: m.sponsor_id,
      rank: m.rank,
      active: m.active,
      cc,
      progress: memberProgress(m.rank, cc, ccMonth),
      onboarding: tpBy[m.id] || null,
      startDate: m.start_date || null,
      warum: m.warum || null,
    };
    if (o.coaching) {
      entry.notes = notesBy[m.id] || [];
      entry.goals = (goalsBy[m.id] || []).map((g) => ({
        id: g.id, goal: g.goal, targetRank: g.target_rank, targetDate: g.target_date, nextStep: g.next_step, status: g.status,
        progress: g.target_rank ? rankGoalProgress(g.target_rank, cc, ccMonth) : null,
      }));
    }
    const bucket = byLeader[m.leader_id];
    if (!bucket) continue;
    bucket.members.push(entry);
    for (const k of months) {
      if (cc[k] != null) bucket.totals[k] = round3((bucket.totals[k] || 0) + cc[k]);
    }
  }
  return { ccMonth, months, byLeader, coachingReady };
}

module.exports = { STEP_KEYS, MEMBER_RANKS, NEXT_RANK, ccMonthKey, memberProgress, rankGoalProgress, loadTeams };
