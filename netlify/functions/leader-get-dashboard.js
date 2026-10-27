// netlify/functions/leader-get-dashboard.js
//
// GET /.netlify/functions/leader-get-dashboard?token=<token>
//
// Lädt die Leaderin anhand ihres persönlichen Tokens (das ist der komplette
// Auth-Mechanismus: kein Treffer = 404), ihre letzten Wochen-Einträge und
// die Strategie für den laufenden Monat, und berechnet den Fortschritt.

const { pgrest } = require('./_lib/supabase');
const { computeProgress, viennaTodayStr } = require('./_lib/ranks');

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const token = event.queryStringParameters && event.queryStringParameters.token;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', {
      query: `token=eq.${encodeURIComponent(token)}&select=id,name,slug,current_rank,manager_achieved_at,vision_image_url,specialized_products`,
    });

    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leader = leaders[0];

    // Besuch protokollieren, fürs Nutzungs-Muster auf der Team-Übersicht.
    // Absichtlich nicht blockierend für den Rest der Antwort.
    try {
      await pgrest('dashboard_visits', { method: 'POST', body: [{ leader_id: leader.id }] });
    } catch (e) { /* Logging-Fehler sollen das Dashboard nicht kaputt machen */ }

    const weeklyEntries = await pgrest('weekly_entries', {
      query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=26`,
    });

    const currentMonthStart = viennaTodayStr().slice(0, 7) + '-01';
    const strategyRows = await pgrest('monthly_strategy', {
      query: `target_month=eq.${currentMonthStart}&select=content`,
    });
    const strategyContent = strategyRows && strategyRows[0] ? strategyRows[0].content : null;
    const strategyReady = !!(strategyContent && strategyContent.trim().length > 0);

    const currentWeekMonday = (() => {
      const today = viennaTodayStr();
      const d = new Date(today + 'T00:00:00Z');
      const day = d.getUTCDay() || 7; // Sonntag=0 -> 7
      d.setUTCDate(d.getUTCDate() - (day - 1));
      return d.toISOString().slice(0, 10);
    })();
    const missingThisWeek = !weeklyEntries.some((e) => e.week_start === currentWeekMonday);

    const progress = computeProgress(leader, weeklyEntries);

    // Erledigt erst, wenn die Fokus-Produkte gewählt sind. Wer nur die alte
    // Einstiegs-Umfrage (ohne Produkte) ausgefüllt hat, bekommt die neue.
    const intakeRows = await pgrest('intake_survey', { query: `leader_id=eq.${leader.id}&select=leader_id,fokus_produkte` });
    const intakeDone = !!(intakeRows && intakeRows[0] && intakeRows[0].fokus_produkte);

    const newTps = await pgrest('new_tps', {
      query: `leader_id=eq.${leader.id}&order=created_at.desc&select=id,tp_name,step_1,step_2,step_3,step_4,step_5,step_6,step_7`,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        name: leader.name,
        slug: leader.slug || null,
        currentRank: leader.current_rank,
        visionImageUrl: leader.vision_image_url || null,
        specializedProducts: leader.specialized_products || null,
        progress,
        recentWeeks: weeklyEntries,
        currentWeekMonday,
        missingThisWeek,
        strategy: { ready: strategyReady, content: strategyReady ? strategyContent : null },
        intakeDone,
        newTps: newTps || [],
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
