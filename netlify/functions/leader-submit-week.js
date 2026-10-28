// netlify/functions/leader-submit-week.js
//
// POST /.netlify/functions/leader-submit-week
// Body: {
//   "token": "...",
//   "week_start": "2026-10-05",   // Montag der aktuellen oder vorherigen ISO-Woche
//   "cc_stand": 12,
//   "geschaeftspraesentationen_versendet": 3,
//   "produkte_verschenkt": 5,
//   "naechstes_event_mitgebracht": 1,
//   "offline_events_eingeladen": 4,
//   "kontakte_gesamt": 20,
//   "nachgefasst": 6,
//   "reflexion_1": "...", "reflexion_2": "...", "reflexion_3": "...",
//   "gesundheit_supplemente": true, "gesundheit_sport": false, "gesundheit_ernaehrung": true
// }
//
// Löst das Token server-seitig zur leader_id auf (nie eine vom Client
// gesendete leader_id vertrauen), validiert week_start, und speichert den
// Eintrag per Upsert (ein Eintrag pro Leaderin pro Woche).

const { pgrest } = require('./_lib/supabase');
const { viennaTodayStr } = require('./_lib/ranks');

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ungültiger Request-Body' }) };
  }

  const { token, week_start } = payload;
  if (!token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token fehlt' }) };
  }
  if (!week_start || isNaN(Date.parse(week_start))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'week_start fehlt oder ungültig' }) };
  }

  // week_start muss die aktuelle oder vorherige Montags-Woche sein, kein
  // beliebiges Datum (Schutz vor versehentlicher Datenverfälschung)
  const today = viennaTodayStr();
  const thisMonday = mondayOf(today);
  const lastMonday = (() => {
    const d = new Date(thisMonday + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  if (week_start !== thisMonday && week_start !== lastMonday) {
    return { statusCode: 400, body: JSON.stringify({ error: 'week_start muss die aktuelle oder vorherige Woche sein' }) };
  }

  try {
    const leaders = await pgrest('leaders', {
      query: `token=eq.${encodeURIComponent(token)}&select=id`,
    });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leaderId = leaders[0].id;

    const numOrNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

    const row = {
      leader_id: leaderId,
      week_start,
      cc_stand: numOrNull(payload.cc_stand),
      geschaeftspraesentationen_versendet: numOrNull(payload.geschaeftspraesentationen_versendet),
      produkte_verschenkt: numOrNull(payload.produkte_verschenkt),
      naechstes_event_mitgebracht: numOrNull(payload.naechstes_event_mitgebracht),
      offline_events_eingeladen: numOrNull(payload.offline_events_eingeladen),
      kontakte_gesamt: numOrNull(payload.kontakte_gesamt),
      nachgefasst: numOrNull(payload.nachgefasst),
      reflexion_1: payload.reflexion_1 || null,
      reflexion_2: payload.reflexion_2 || null,
      reflexion_3: payload.reflexion_3 || null,
      gesundheit_supplemente: payload.gesundheit_supplemente === true,
      gesundheit_sport: payload.gesundheit_sport === true,
      gesundheit_ernaehrung: payload.gesundheit_ernaehrung === true,
    };

    const save = (body) =>
      pgrest('weekly_entries', {
        method: 'POST',
        query: 'on_conflict=leader_id,week_start',
        prefer: 'resolution=merge-duplicates,return=representation',
        body: [body],
      });

    try {
      await save(row);
    } catch (err) {
      // Solange die Gesundheits- bzw. Nachgefasst-Spalten in Supabase noch nicht angelegt sind
      // (PostgREST-Fehler PGRST204), ohne sie speichern statt den ganzen
      // Eintrag zu verlieren
      if (!(err.data && err.data.code === 'PGRST204')) throw err;
      const { gesundheit_supplemente, gesundheit_sport, gesundheit_ernaehrung, nachgefasst, ...rest } = row;
      await save(rest);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
