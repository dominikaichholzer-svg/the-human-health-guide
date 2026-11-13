// netlify/functions/admin-get-overview.js
//
// GET /.netlify/functions/admin-get-overview?key=<ADMIN_SECRET_KEY>
//
// Übersicht über alle 5 Leaderinnen für Dominik: Rang, Fortschritt, letzte
// Einträge, plus die Strategie-Texte für diesen und nächsten Monat.

const { pgrest } = require('./_lib/supabase');
const { requireAdmin } = require('./_lib/auth');
const { loadTeams } = require('./_lib/team');
const { memberSignals, leaderSignals } = require('./_lib/signals');
const { logAccess } = require('./_lib/auth');
const { monthsBack } = require('./_lib/ranks');
const { computeProgress, viennaTodayStr } = require('./_lib/ranks');
const { planWindow } = require('./_lib/plan');

function nextMonthStart(todayStr) {
  const [y, m] = todayStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m ist 1-basiert, also schon "nächster Monat" Index 0-basiert
  return d.toISOString().slice(0, 10);
}

function daysAgo(todayStr, n) {
  const d = new Date(todayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Besuche je Kalendertag zählen, fürs Heatmap auf der Team-Übersicht
function aggregateVisitsByDay(visits) {
  const byDay = {};
  for (const v of visits || []) {
    const day = v.visited_at.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  }
  return byDay;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const key = event.queryStringParameters && event.queryStringParameters.key;
  const adminCheck = await requireAdmin(event, null);
  if (!adminCheck.ok) return adminCheck.response;

  try {
    const leaders = await pgrest('leaders', {
      query: 'select=id,name,current_rank,manager_achieved_at,specialized_products&order=sort_order.asc',
    });

    // Login-Status (Spalten aus supabase/auth.sql). Fehlen sie noch, lädt die
    // Übersicht trotzdem, nur ohne diese Angaben.
    const loginById = {};
    try {
      const rows = await pgrest('leaders', { query: 'select=*' });
      for (const r of rows || []) {
        loginById[r.id] = { username: r.username, hasPassword: !!r.password_hash, passwordSetAt: r.password_set_at, consentAt: r.consent_at };
      }
    } catch (e) { /* noch nicht eingerichtet */ }

    // "Mein Team" je Leaderin (supabase/team.sql). Fehlt die Tabelle noch, ohne.
    let teams = null;
    try {
      teams = await loadTeams((leaders || []).map((l) => l.id), viennaTodayStr(), { coaching: true });
      const t0 = viennaTodayStr();
      for (const id of Object.keys(teams.byLeader)) {
        for (const m of teams.byLeader[id].members) m.signals = memberSignals(m, teams.ccMonth, t0);
      }
      // Dominik liest die Coaching-Notizen der Leaderinnen mit: das wird protokolliert
      if (teams.coachingReady) await logAccess(null, 'admin_read_coaching_notes', event);
    } catch (e) { /* noch nicht eingerichtet */ }

    // Eigene Notizen von Dominik zu seinen Leaderinnen (nur Admin)
    const adminNotesBy = {};
    try {
      const rows = await pgrest('coaching_notes', { query: 'author=eq.admin&order=created_at.desc&select=id,leader_id,note,created_at' });
      for (const r of rows || []) (adminNotesBy[r.leader_id] = adminNotesBy[r.leader_id] || []).push({ id: r.id, note: r.note, createdAt: r.created_at });
    } catch (e) { /* noch nicht eingerichtet */ }

    const today = viennaTodayStr();
    const currentMonthStart = today.slice(0, 7) + '-01';
    const nextMonthStartStr = nextMonthStart(today);

    const leaderSummaries = [];
    for (const leader of leaders) {
      const weeklyEntries = await pgrest('weekly_entries', {
        query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=10`,
      });
      const progress = computeProgress(leader, weeklyEntries);

      const insightRows = await pgrest('ai_insights', {
        query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=1&select=insight,week_start`,
      });
      const latestInsight = insightRows && insightRows[0] ? insightRows[0] : null;

      const intakeRows = await pgrest('intake_survey', {
        query: `leader_id=eq.${leader.id}&select=*`,
      });
      const intake = intakeRows && intakeRows[0] ? intakeRows[0] : null;

      let monthlyPlans = [];
      try {
        const pw = planWindow(today);
        monthlyPlans = await pgrest('monthly_plans', {
          query: `leader_id=eq.${leader.id}&target_month=in.(${pw.current},${pw.next})&order=target_month.asc&select=target_month,plan_cc,sponsoring_cc,eigen_cc,kunden_cc,kunden_text,team_cc`,
        });
      } catch (e) { monthlyPlans = []; }

      let recentDays = [];
      try {
        recentDays = await pgrest('daily_reflections', {
          query: `leader_id=eq.${leader.id}&order=entry_date.desc&limit=7&select=entry_date,kontakte_heute,verkaeufe_heute,stimmung,gut,schwer,morgen`,
        });
      } catch (e) { recentDays = []; }

      const sinceDate = daysAgo(today, 55);
      const visits = await pgrest('dashboard_visits', {
        query: `leader_id=eq.${leader.id}&visited_at=gte.${sinceDate}&select=visited_at`,
      });
      const visitsByDay = aggregateVisitsByDay(visits);

      // Hinweise auf Coaching-Bedarf der Leaderin selbst (nur Admin)
      let prevPlans = [];
      try {
        prevPlans = await pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=eq.${monthsBack(today, 2)[0]}-01&select=target_month,plan_cc` });
      } catch (e) { prevPlans = []; }
      const signals = leaderSignals({ weeks: weeklyEntries, days: recentDays, plans: prevPlans }, today);

      leaderSummaries.push({
        id: leader.id,
        name: leader.name,
        currentRank: leader.current_rank,
        specializedProducts: leader.specialized_products || '',
        intake,
        progress,
        recentWeeks: weeklyEntries,
        lastSubmitted: weeklyEntries[0] ? weeklyEntries[0].week_start : null,
        latestInsight,
        visitsByDay,
        recentDays,
        monthlyPlans,
        login: loginById[leader.id] || null,
        team: teams ? teams.byLeader[leader.id] : null,
        signals,
        adminNotes: adminNotesBy[leader.id] || [],
      });
    }

    const strategyRows = await pgrest('monthly_strategy', {
      query: `target_month=in.(${currentMonthStart},${nextMonthStartStr})&select=target_month,content`,
    });
    const strategyByMonth = {};
    for (const row of strategyRows || []) strategyByMonth[row.target_month] = row.content;

    return {
      statusCode: 200,
      body: JSON.stringify({
        leaders: leaderSummaries,
        teamMonths: teams ? teams.months : [],
        teamCcMonth: teams ? teams.ccMonth : null,
        strategy: {
          currentMonth: { target_month: currentMonthStart, content: strategyByMonth[currentMonthStart] || '' },
          nextMonth: { target_month: nextMonthStartStr, content: strategyByMonth[nextMonthStartStr] || '' },
        },
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
