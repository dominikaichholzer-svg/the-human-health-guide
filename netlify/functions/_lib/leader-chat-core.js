// netlify/functions/_lib/leader-chat-core.js
//
// JARVIS im Chat der Leaderinnen: Persönlichkeit, Leitplanken, Kontext und
// (ab Schritt 2) Werkzeuge als Lernbegleiter:
//   - unterlage_fragen: in freigegebenen Schulungen und Unterlagen nachschlagen
//   - lernnotiz_speichern: Erkenntnis oder Aufgabe für sie speichern
// Benutzt von leader-chat.js (Fallback ohne Werkzeuge) und leader-chat-background.js.

const { pgrest } = require('./supabase');
const { PANEL_WISDOM } = require('./panel-wisdom');
const { buildLeaderContext } = require('./leader-context');
const { viennaTodayStr } = require('./ranks');
const books = require('./books');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Leitplanken für Phase 4: JARVIS empfiehlt, entscheidet aber nie über Menschen
const GUARDRAILS = `Leitplanken, die immer gelten:
- Du siehst unten die echten Daten der Leaderin und ihres Teams. Nutze sie, wenn sie zur Frage passen, und erfinde keine Zahlen. Fehlt etwas, sag es und schlag vor, es im Dashboard einzutragen.
- Du triffst nie Entscheidungen über Menschen. Du bewertest nicht, ob eine Partnerin "es schafft", ob sich jemand lohnt oder ob man sich von jemandem trennen oder weniger kümmern sollte. Du gibst Beobachtungen, Fragen und Gesprächsideen. Die Entscheidung trifft immer die Leaderin selbst.
- Die Coaching-Notizen sind vertraulich. Zitiere sie nur, wenn es hilft, und schlag nie vor, sie an andere weiterzugeben.
- Keine Heil- oder Einkommensversprechen.`;

const PREPARE_PROMPT = (name) => `Bereite mein nächstes Coaching-Gespräch mit ${name} vor. Nutze ihre Zahlen, Ziele, Hinweise und meine Notizen. Gib mir kurz:
1. einen wertschätzenden, konkreten Einstieg,
2. drei offene Fragen, die ich stellen kann,
3. worauf ich achten sollte,
4. einen möglichen gemeinsamen nächsten Schritt, den sie selbst festlegt.`;
const PLAN_PROMPT = 'Ich liege hinter meinem Monatsplan. Gib mir 3 konkrete Ideen für die restlichen Tage, passend zu meinem Plan und meinem Kundenkonzept.';

const SYSTEM_PROMPT = `Du bist JARVIS, ein Business-Coaching-Assistent für die Team-Leaderinnen bei einem Forever-Living-Team (Aloe-Vera-Produkte, Direktvertrieb/Network-Marketing). Die Leaderinnen chatten mit dir, wenn sie Ideen brauchen: wie sie jemanden ansprechen, ihre Woche planen, mit einem Einwand umgehen, oder einfach eine zweite Meinung wollen.

Wichtiger Kontext zum Team-System, damit deine Antworten wirklich passen:
- Grundprinzip der Ansprache: immer ein echtes, ehrliches Kompliment zuerst, nie ein kalter Pitch. Nicht "ich bin selbstständig und suche Testpersonen", sondern eher "ich lerne gerade Leute/die Gegend kennen" als Rahmen.
- Bei Produkttests/Umfragen: Kontakt sichern (Name + Nummer/Insta) ist das Wichtigste, sonst verpufft der Kontakt.
- Conversion von Kunde zu Team-Partnerin passiert meist NICHT über kalte Geschäfts-Pitches, sondern dadurch dass jemand vom Produkt begeistert ist und dann persönlich gefragt wird, ob sie die Produkte dauerhaft 30% günstiger bekommen will (als FPC/Vorzugskunde oder FBO/Geschäftspartnerin).
- 3-Monats-Zyklus: Monat 1 = Verschenken (Testboxen, Kontakte sammeln), Monat 2 = Nachfassen & Verkaufen (30%-Rabatt anbieten), Monat 3 = Einladen (Open House/Business-Präsentation).
- Rangweg: Supervisor → Assistant Manager → Manager → Eagle Manager. Ziel ist Manager bis 30.04.2027, dann das Eagle-Jahr bis 30.04.2028.
- Einwände immer erst anerkennen, dann locker antworten, nie dagegenhalten.

Antworte auf Deutsch, warm aber knapp (2-5 Sätze meistens, außer explizit mehr verlangt wird), konkret und direkt umsetzbar, keine generischen Motivationsfloskeln. Wenn eine Frage nichts mit dem Geschäft zu tun hat, darfst du trotzdem freundlich helfen, aber dein Schwerpunkt ist Business-Coaching.`;


const LEARNING = `Du bist zugleich ihr persönlicher Lern- und Entwicklungsbegleiter. Ziel: Sie lernt, sich selbst zu führen und andere zu entwickeln, statt von dir oder Dominik abhängig zu sein.
- Passe Tiefe und Beispiele an ihren Rang an (Supervisor: eigenes Geschäft, Kundinnen, erste Partnerinnen; Assistant Manager und Manager: zusätzlich Partnerinnen entwickeln und führen).
- Richte Empfehlungen auf ihren Entwicklungsschwerpunkt aus, wenn es passt.
- Bei Fragen zu Abläufen, Kundenkonzepten, Vergütung, Einwänden, Präsentation, Partnergewinnung oder Teamführung schau mit unterlage_fragen in die passende freigegebene Unterlage und nenne die Quelle ("Laut Schulung ..."). Zahlen nur so, wie sie in der Unterlage stehen.
- Wenn sie üben will oder es hilft: gib eine kurze Übung, ein Rollenspiel (du spielst die Kundin), einen Gesprächsleitfaden oder einen Wochenplan mit konkreten Aufgaben.
- Stell lieber eine gute Rückfrage, damit sie selbst die Lösung findet, statt alles vorzugeben, wenn sie ein eigenes Problem schildert.
- Wenn sie sagt "speicher das", "merk dir das als Aufgabe" o. ä., nutze lernnotiz_speichern. Biete das bei wertvollen Erkenntnissen auch von dir aus kurz an, aber speichere nur, wenn sie zustimmt.
- Fehlen Informationen, frag nach, statt Zusammenhänge zu erfinden.`;

const LEVELS = { alle: 0, ab_assistant_manager: 1, ab_manager: 2 };
const RANK_LEVEL = { supervisor: 0, assistant_manager: 1, manager: 2, eagle_manager: 2 };

// Freigegebene Unterlagen für ihren Rang (null = noch nicht eingerichtet)
async function allowedDocs(leader) {
  let rows;
  try {
    rows = await pgrest('agent_books', { query: 'team_level=not.is.null&order=id.asc&select=id,title,summary,team_level' });
  } catch (e) { return null; }
  const lvl = RANK_LEVEL[leader.current_rank] != null ? RANK_LEVEL[leader.current_rank] : 0;
  return (rows || []).filter((b) => (LEVELS[b.team_level] != null ? LEVELS[b.team_level] : 99) <= lvl);
}

const TOOLS = [
  {
    name: 'unterlage_fragen',
    description: 'Schlägt in einer freigegebenen Schulung oder Unterlage nach (Liste im Systemprompt) und liefert die passenden Aussagen.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'ID der Unterlage aus der Liste' },
        frage: { type: 'string', description: 'Was in der Unterlage gesucht wird' },
      },
      required: ['id', 'frage'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'lernnotiz_speichern',
    description: 'Speichert eine Erkenntnis (art "notiz") oder eine Aufgabe (art "aufgabe") in ihren Lernnotizen. Nur auf ihren Wunsch.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Kurz und klar, in Du-Form, höchstens 3 Sätze' },
        art: { type: 'string', enum: ['notiz', 'aufgabe'] },
      },
      required: ['text', 'art'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// Was als Frage gilt: freier Text, Gesprächsvorbereitung oder Plan-Ideen
async function resolveMessage(leader, payload) {
  const freeText = typeof payload.message === 'string' ? payload.message.trim().slice(0, 4000) : '';
  if (payload.prepare_member_id) {
    if (!UUID.test(String(payload.prepare_member_id))) return { status: 400, error: 'Ungültige Partnerin' };
    const rows = await pgrest('team_members', { query: `id=eq.${payload.prepare_member_id}&leader_id=eq.${leader.id}&select=name` });
    if (!rows || !rows[0]) return { status: 404, error: 'Nicht gefunden' };
    return { message: PREPARE_PROMPT(rows[0].name) };
  }
  if (payload.ask === 'plan') return { message: PLAN_PROMPT };
  if (!freeText) return { status: 400, error: 'Nachricht fehlt' };
  return { message: freeText };
}

function cleanHistory(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
}

async function systemFor(leader, docs) {
  const today = viennaTodayStr();
  let contextText = '';
  try {
    contextText = (await buildLeaderContext(leader, today)).text;
  } catch (e) {
    contextText = 'Die Dashboard-Daten sind gerade nicht verfügbar.';
  }
  const seasonal = today.startsWith('2026-11')
    ? '\n- November 2026 ist ein Sondermonat: Fokus auf Weihnachtsgeschenke verkaufen. Jede Leaderin hat eine persönliche Geschenke-Umfrage mit 9 Sets (Haar, Gesicht, Körper in small, medium, large), den Link findet sie im Dashboard unter Überblick.'
    : '';
  const lib = docs && docs.length
    ? `\n\nFreigegebene Unterlagen für sie (für unterlage_fragen):\n${docs.map((d) => `[${d.id}] ${d.title}: ${String(d.summary || '').slice(0, 220)}`).join('\n')}`
    : '';
  return SYSTEM_PROMPT + seasonal + '\n\n' + GUARDRAILS + (docs ? '\n\n' + LEARNING : '') + '\n\n' + PANEL_WISDOM + `\n\nDu sprichst gerade mit ${leader.name} (Rang: ${leader.current_rank}).\n\nIhre Dashboard-Daten:\n${contextText}` + lib;
}

async function runTool(client, leader, docs, block) {
  const input = block.input || {};
  try {
    if (block.name === 'unterlage_fragen') {
      const doc = (docs || []).find((d) => d.id === Number(input.id));
      if (!doc) return { type: 'tool_result', tool_use_id: block.id, content: 'Diese Unterlage ist für sie nicht freigegeben.', is_error: true };
      const book = await books.getBook(doc.id);
      const answer = await books.askBook(client, book, String(input.frage || '').slice(0, 1000));
      return { type: 'tool_result', tool_use_id: block.id, content: `Aus "${doc.title}":\n${answer}` };
    }
    if (block.name === 'lernnotiz_speichern') {
      const text = String(input.text || '').trim().slice(0, 1500);
      if (!text) throw new Error('Text fehlt');
      await pgrest('learning_notes', { method: 'POST', body: [{ leader_id: leader.id, kind: input.art === 'aufgabe' ? 'task' : 'note', text, source: 'chat' }] });
      return { type: 'tool_result', tool_use_id: block.id, content: 'Gespeichert. Sie findet es im Chat unter "Deine Lernnotizen".' };
    }
    throw new Error('Unbekanntes Werkzeug');
  } catch (err) {
    return { type: 'tool_result', tool_use_id: block.id, content: `Fehler: ${err.message}`, is_error: true };
  }
}

// opts.tools: Werkzeuge erlauben (nur im Hintergrund, weil Nachschlagen dauert)
async function answer(client, leader, message, history, opts) {
  const o = opts || {};
  const docs = o.tools ? await allowedDocs(leader) : null;
  const system = await systemFor(leader, docs);
  const messages = [...cleanHistory(history), { role: 'user', content: message }];
  const useTools = !!(o.tools && docs);
  for (let round = 0; round < 6; round++) {
    const response = await client.beta.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 6000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      ...(useTools ? { tools: TOOLS } : {}),
      messages,
    });
    if (response.stop_reason === 'refusal') return 'Dazu kann ich dir gerade leider nichts sagen. Frag mich gern etwas anderes.';
    if (response.stop_reason === 'tool_use' && useTools) {
      messages.push({ role: 'assistant', content: response.content });
      const uses = response.content.filter((b) => b.type === 'tool_use');
      const results = await Promise.all(uses.map((b) => runTool(client, leader, docs, b)));
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || 'Dazu kann ich dir gerade leider nichts sagen. Frag mich gern etwas anderes.';
  }
  return 'Ich habe zu viele Schritte gebraucht. Frag mich bitte etwas genauer.';
}

module.exports = { resolveMessage, answer, allowedDocs, TOOLS, PREPARE_PROMPT, PLAN_PROMPT };
