// netlify/functions/scheduled-weekly-insight.js
//
// Läuft täglich (siehe netlify.toml). Für jede Leaderin: wenn ihr letzter
// Wochen-Eintrag noch kein AI-Insight hat, wird eines über die Claude API
// erzeugt und gespeichert. So entsteht unabhängig davon, an welchem Tag
// jemand einträgt, innerhalb eines Tages ein neues Insight für Dominik.

const { pgrest } = require('./_lib/supabase');
const { PANEL_WISDOM } = require('./_lib/panel-wisdom');

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function buildPrompt(leader, entry) {
  const rows = [
    ['CC-Stand (laufender Monat)', entry.cc_stand],
    ['Geschäftspräsentationen versendet', entry.geschaeftspraesentationen_versendet],
    ['Produkte verschenkt', entry.produkte_verschenkt],
    ['Fürs nächste Event mitgebracht', entry.naechstes_event_mitgebracht],
    ['Zu Offline-Events eingeladen', entry.offline_events_eingeladen],
    ['Kontakte gesamt', entry.kontakte_gesamt],
    ['Nachgefasst', entry.nachgefasst],
  ].map(([label, val]) => `${label}: ${val != null ? val : 'keine Angabe'}`).join('\n');

  const yesNo = (v) => (v === true ? 'ja' : v === false ? 'nein' : 'keine Angabe');
  const health = [
    `Supplemente genommen: ${yesNo(entry.gesundheit_supplemente)} (Details bespricht Dominik persönlich, nicht ins Insight schreiben, welche)`,
    `Mindestens 2,5 Stunden Sport: ${yesNo(entry.gesundheit_sport)}`,
    `Gesund ernährt: ${yesNo(entry.gesundheit_ernaehrung)}`,
  ].join('\n');

  return `Du hilfst Dominik, der ein Network-Marketing-Team führt, dabei, eine der Leaderinnen aus dem Team besser zu coachen. Die Leaderin heißt ${leader.name}, aktueller Rang: ${leader.current_rank}. Ziel ist Manager-Rang bis 30.04.2027, danach die Eagle-Manager-Qualifikation bis 30.04.2028.

Das sind ${leader.name}s Zahlen und Antworten aus ihrem letzten Wochen-Eintrag:

${rows}

Gesundheit diese Woche (die Leaderinnen sollen selbst gesund leben, das ist Teil ihrer Glaubwürdigkeit):
${health}

Was diese Woche am meisten Energie gekostet hat: ${entry.reflexion_1 || 'keine Angabe'}
Was diese Woche gut funktioniert hat: ${entry.reflexion_2 || 'keine Angabe'}
Wo sie sich Unterstützung wünscht: ${entry.reflexion_3 || 'keine Angabe'}

${PANEL_WISDOM}

Schreib für Dominik ein kurzes, konkretes Insight auf Deutsch (3-4 Sätze, keine Aufzählung, kein Smalltalk-Einstieg). Sag Dominik, was aus diesen Antworten über den aktuellen Zustand von ${leader.name} hervorgeht, und was Dominik diese Woche konkret tun oder ansprechen könnte, um ${leader.name} zu unterstützen. Gesundheit nur erwähnen, wenn dort etwas auffällt. Keine generischen Motivationsfloskeln, nur was wirklich aus diesen Angaben hervorgeht. Wenn die Zahlen oder Antworten nichts Auffälliges zeigen, sag das ehrlich statt etwas zu erfinden.`;
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      ...(process.env.ANTHROPIC_WORKSPACE_ID && { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID }),
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.content && data.content[0] ? data.content[0].text : null;
}

exports.handler = async function () {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'ANTHROPIC_API_KEY fehlt' }) };
  }

  try {
    const leaders = await pgrest('leaders', { query: 'select=id,name,current_rank' });
    const results = [];

    for (const leader of leaders) {
      const entries = await pgrest('weekly_entries', {
        query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=1`,
      });
      const entry = entries && entries[0];
      if (!entry) { results.push({ leader: leader.name, skipped: 'kein Eintrag' }); continue; }

      const existing = await pgrest('ai_insights', {
        query: `leader_id=eq.${leader.id}&week_start=eq.${entry.week_start}&select=id`,
      });
      if (existing && existing.length > 0) { results.push({ leader: leader.name, skipped: 'schon vorhanden' }); continue; }

      const insightText = await callClaude(buildPrompt(leader, entry));
      if (!insightText) { results.push({ leader: leader.name, skipped: 'keine Antwort von Claude' }); continue; }

      await pgrest('ai_insights', {
        method: 'POST',
        body: [{ leader_id: leader.id, week_start: entry.week_start, insight: insightText }],
      });
      results.push({ leader: leader.name, created: true });
    }

    return { statusCode: 200, body: JSON.stringify({ results }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
