// netlify/functions/leader-submit-day.js
//
// POST /.netlify/functions/leader-submit-day
// Body: {
//   "token": "...",
//   "entry_date": "2026-11-12",   // heute oder gestern (Wien)
//   "kontakte_heute": 10,
//   "verkaeufe_heute": 1.903,    // Verkäufe des Tages in CC, bis 3 Nachkommastellen
//   "stimmung": 4,                // 1 bis 5
//   "gut": "...", "schwer": "...", "morgen": "..."
// }
//
// Tägliche Kurz-Reflexion. Löst das Token server-seitig zur leader_id auf
// und speichert per Upsert (ein Eintrag pro Leaderin pro Tag).

const { pgrest } = require('./_lib/supabase');
const { requireLeader } = require('./_lib/auth');
const { viennaTodayStr } = require('./_lib/ranks');

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
  const stimmung = intOrNull(payload.stimmung);
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 2000) : null);

  try {
    const auth = await requireLeader(event, payload);
    if (!auth.ok) return auth.response;
    const leaders = [auth.leader];

    const row = {
      leader_id: leaders[0].id,
      entry_date,
      kontakte_heute: intOrNull(payload.kontakte_heute),
      verkaeufe_heute: ccOrNull(payload.verkaeufe_heute),
      gespraeche_heute: intOrNull(payload.gespraeche_heute),
      neue_kunden_heute: intOrNull(payload.neue_kunden_heute),
      stimmung: stimmung >= 1 && stimmung <= 5 ? stimmung : null,
      gut: text(payload.gut),
      schwer: text(payload.schwer),
      morgen: text(payload.morgen),
      updated_at: new Date().toISOString(),
    };

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
      // Spalten aus supabase/devplans.sql fehlen noch: ohne sie speichern
      if (!(err.data && err.data.code === 'PGRST204')) throw err;
      const { gespraeche_heute, neue_kunden_heute, ...rest } = row;
      saved = await save(rest);
    }

    return { statusCode: 200, body: JSON.stringify({ success: true, entry: saved && saved[0] }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
