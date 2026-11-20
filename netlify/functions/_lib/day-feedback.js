// netlify/functions/_lib/day-feedback.js
//
// Kurze Rückmeldung von JARVIS nach dem Tagesabschluss: ein, zwei warme Sätze
// und nur bei Bedarf EINE kurze Rückfrage (kein Fragebogen). Läuft im
// Hintergrund über chat_jobs (Typ "day"), Ergebnis landet in
// daily_reflections.jarvis_notiz / jarvis_frage. Ihre Antwort (frage_antwort)
// fließt ins Wochen-Coaching ein.

const { pgrest } = require('./supabase');

const MODEL = 'claude-sonnet-5-5';
const cut = (t, n) => (t == null || t === '' ? null : String(t).replace(/\s+/g, ' ').trim().slice(0, n));

const SCHEMA = {
  type: 'object',
  properties: {
    nachricht: { type: 'string', description: 'Ein bis zwei Sätze, warm und konkret auf ihren Tag bezogen. Keine Floskeln.' },
    frage: { type: 'string', description: 'Höchstens EINE kurze, offene Rückfrage, nur wenn sie ihr wirklich hilft weiterzudenken. Sonst leerer String.' },
  },
  required: ['nachricht', 'frage'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, persönlicher Mentor einer Leaderin in Dominiks Forever-Living-Team. Sie hat gerade ihren kurzen Tagesabschluss eingetragen. Antworte wie ein Mentor, der zuhört: ein bis zwei Sätze, die zeigen, dass du ihren Tag wirklich gelesen hast. Würdige echte Erfolge, nimm Schwieriges ernst, ohne zu dramatisieren. Nur wenn es ihr hilft, stellst du EINE kurze offene Rückfrage (z. B. wenn etwas Schwieriges anklingt oder ein Erfolg einen Grund hat, den sie erkennen sollte). An den meisten Tagen reicht die Nachricht ohne Frage (frage = leerer String). Keine Bewertung, keine Vorwürfe, keine Ratschläge-Liste, keine Heil- oder Einkommensversprechen. Erfinde nichts. Deutsch, Du-Form, keine Bindestriche als Satzverbinder.`;

async function dayFeedback(client, leader, entryDate) {
  const rows = await pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=lte.${entryDate}&order=entry_date.desc&limit=4&select=*` });
  const today = (rows || []).find((r) => r.entry_date === entryDate);
  if (!today || !(today.bewegt || today.gut || today.schwer)) return null;
  const fmt = (d) => `${d.entry_date}: Gefühl ${d.gefuehl != null ? d.gefuehl + '/10' : d.stimmung != null ? d.stimmung + '/5' : '–'}. Bewegt: ${cut(d.bewegt, 400) || '–'}. Schönster Erfolg: ${cut(d.gut, 400) || '–'}. Schwergefallen: ${cut(d.schwer, 400) || '–'}.`;
  const earlier = (rows || []).filter((r) => r.entry_date !== entryDate).map(fmt);
  const prompt = `Leaderin: ${leader.name}.\n\nIhr Tagesabschluss:\n${fmt(today)}\n\nDie Tage davor (nur als Hintergrund):\n${earlier.length ? earlier.join('\n') : 'Keine.'}`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) return null;
  const out = JSON.parse(block.text);
  const frage = out.frage && String(out.frage).trim() ? String(out.frage).trim().slice(0, 300) : null;
  const patch = { jarvis_notiz: String(out.nachricht || '').trim().slice(0, 600) || null, jarvis_frage: frage };
  // Neue Frage: alte Antwort passt nicht mehr dazu
  if (frage !== today.jarvis_frage) patch.frage_antwort = null;
  await pgrest('daily_reflections', { method: 'PATCH', query: `leader_id=eq.${leader.id}&entry_date=eq.${entryDate}`, body: patch });
  return { nachricht: patch.jarvis_notiz, frage };
}

module.exports = { dayFeedback };
