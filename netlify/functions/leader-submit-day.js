// netlify/functions/leader-submit-day.js
//
// POST /.netlify/functions/leader-submit-day
// Body: {
//   "token": "...",
//   "entry_date": "2026-11-12",   // heute oder gestern (Wien)
//   "kontakte_heute": 10,
//   "verkaeufe_heute": 1.903,    // Verkäufe des Tages in CC, bis 3 Nachkommastellen
//   "gefuehl": 7,                 // 1 bis 10 (stimmung 1 bis 5 wird daraus abgeleitet)
//   "bewegt": "...",              // Was hast du heute für dein Business bewegt?
//   "gut": "...",                 // Was war heute dein schönster Erfolg?
//   "schwer": "..."               // Was ist dir heute schwergefallen?
// }
// Oder { entry_date, only_answer: true, frage_antwort } = Antwort auf JARVIS' Rückfrage.
// Antwort: { success, entry, jobId }  jobId = JARVIS' kurze Rückmeldung (leader-chat-poll)
//
// Tägliche Kurz-Reflexion. Löst das Token server-seitig zur leader_id auf
// und speichert per Upsert (ein Eintrag pro Leaderin pro Tag).

const { pgrest } = require('./_lib/supabase');
const { requireLeader } = require('./_lib/auth');
const { viennaTodayStr } = require('./_lib/ranks');
const { agentSecret } = require('./_lib/telegram');

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
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

  const { token, entry_date } = payload;
  const today = viennaTodayStr();
  const yesterday = addDays(today, -1);
  if (entry_date !== today && entry_date !== yesterday) {
    return { statusCode: 400, body: JSON.stringify({ error: 'entry_date muss heute oder gestern sein' }) };
  }

  const intOrNull = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
  };
  // CC mit bis zu 3 Nachkommastellen, Komma wird als Dezimalzeichen akzeptiert
  const ccOrNull = (v) => {
    if (v === '' || v === undefined || v === null) return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null;
  };
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);
  // Gefühl 1 bis 10 (neu). Die alte Stimmung 1 bis 5 wird daraus weiter befüllt,
  // damit bestehende Auswertungen funktionieren.
  const g = intOrNull(payload.gefuehl);
  const gefuehl = g >= 1 && g <= 10 ? g : null;
  const s = intOrNull(payload.stimmung);
  const stimmung = gefuehl ? Math.ceil(gefuehl / 2) : (s >= 1 && s <= 5 ? s : null);

  try {
    const auth = await requireLeader(event, payload);
    if (!auth.ok) return auth.response;
    const leaders = [auth.leader];

    // Nur die Antwort auf JARVIS' Rückfrage speichern
    if (payload.only_answer) {
      await pgrest('daily_reflections', {
        method: 'PATCH',
        query: `leader_id=eq.${leaders[0].id}&entry_date=eq.${entry_date}`,
        body: { frage_antwort: text(payload.frage_antwort), updated_at: new Date().toISOString() },
      });
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    const row = {
      leader_id: leaders[0].id,
      entry_date,
      kontakte_heute: intOrNull(payload.kontakte_heute),
      verkaeufe_heute: ccOrNull(payload.verkaeufe_heute),
      gespraeche_heute: intOrNull(payload.gespraeche_heute),
      neue_kunden_heute: intOrNull(payload.neue_kunden_heute),
      stimmung,
      gefuehl,
      bewegt: text(payload.bewegt),
      gut: text(payload.gut),
      schwer: text(payload.schwer),
      updated_at: new Date().toISOString(),
    };
    // "morgen" gibt es im neuen Formular nicht mehr: alte Einträge bleiben unberührt
    if (payload.morgen !== undefined) row.morgen = text(payload.morgen);

    const save = (body) => pgrest('daily_reflections', {
      method: 'POST',
      query: 'on_conflict=leader_id,entry_date',
      prefer: 'resolution=merge-duplicates,return=representation',
      body: [body],
    });
    let saved;
    try {
      saved = await save(row);
    } catch (err) {
      // Spalten aus supabase/weekly-coaching.sql oder devplans.sql fehlen noch:
      // ohne sie speichern, damit nichts verloren geht
      if (!(err.data && err.data.code === 'PGRST204')) throw err;
      const { gefuehl: _g, bewegt: _b, ...rest } = row;
      try {
        saved = await save(rest);
      } catch (err2) {
        if (!(err2.data && err2.data.code === 'PGRST204')) throw err2;
        const { gespraeche_heute, neue_kunden_heute, ...rest2 } = rest;
        saved = await save(rest2);
      }
    }

    // Kurze Rückmeldung von JARVIS im Hintergrund (nur wenn sie etwas geschrieben hat)
    let jobId = null;
    if ((row.bewegt || row.gut || row.schwer) && process.env.ANTHROPIC_API_KEY) {
      try {
        const jobs = await pgrest('chat_jobs', {
          method: 'POST',
          prefer: 'return=representation',
          body: [{ leader_id: leaders[0].id, status: 'pending', request: { type: 'day', entry_date }, shown_message: null }],
        });
        const job = jobs && jobs[0];
        if (job) {
          await fetch(`${process.env.URL}/.netlify/functions/leader-chat-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
            body: JSON.stringify({ job_id: job.id }),
          });
          jobId = job.id;
        }
      } catch (e) { jobId = null; }
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, entry: saved && saved[0], jobId }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
