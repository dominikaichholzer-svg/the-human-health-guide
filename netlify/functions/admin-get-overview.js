// netlify/functions/admin-get-overview.js
//
// GET /.netlify/functions/admin-get-overview?key=<ADMIN_SECRET_KEY>
//
// Übersicht über alle 5 Leaderinnen für Dominik: Rang, Fortschritt, letzte
// Einträge, plus die Strategie-Texte für diesen und nächsten Monat.

const { pgrest } = require('./_lib/supabase');
const { computeProgress, viennaTodayStr } = require('./_lib/ranks');

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
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Kein Zugriff' }) };
  }

  try {
    const leaders = await pgrest('leaders', {
      query: 'select=id,name,current_rank,manager_achieved_at,specialized_products&order=sort_order.asc',
    });

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

      const sinceDate = daysAgo(today, 55);
      const visits = await pgrest('dashboard_visits', {
        query: `leader_id=eq.${leader.id}&visited_at=gte.${sinceDate}&select=visited_at`,
      });
      const visitsByDay = aggregateVisitsByDay(visits);

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
