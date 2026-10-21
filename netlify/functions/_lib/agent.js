// netlify/functions/_lib/agent.js
//
// Dominiks persönlicher Agent ("JARVIS"). Ein Claude-Agent mit eigenen
// Tools: Team-Zahlen aus Supabase lesen, neue Leads aus MailerLite
// ansehen, sich Dinge dauerhaft merken, im Web suchen. Wird vom
// Telegram-Bot (telegram-agent-background.js) und vom Morgen-Briefing
// benutzt.
//
// Gesprächsverlauf und Gedächtnis liegen in Supabase (agent_messages,
// agent_memory), siehe supabase/agent-tables.sql.

const AnthropicModule = require('@anthropic-ai/sdk');
const Anthropic = AnthropicModule.default || AnthropicModule;
const { pgrest } = require('./supabase');
const { computeProgress, viennaTodayStr } = require('./ranks');
const books = require('./books');

const MODEL = 'claude-opus-5-5';
const MAX_TOOL_ROUNDS = 15;

const SYSTEM_PROMPT = `Du bist JARVIS, der persönliche Business-Agent von Dominik. Dominik führt ein Forever-Living-Team (Aloe-Vera-Produkte, Direktvertrieb/Network-Marketing) mit 5 Leaderinnen. Dominik schreibt dir über Telegram, oft unterwegs vom Handy.

Was du über das Business weißt:
- Ziel der Leaderinnen: Manager-Rang bis 30.04.2027, danach das Eagle-Manager-Jahr bis 30.04.2028. Rangweg: Supervisor → Assistant Manager → Manager → Eagle Manager. "CC" ist das Umsatz-Volumen, "CC-Stand" das CC des laufenden Monats.
- Grundprinzip der Ansprache im Team: immer ein echtes, ehrliches Kompliment zuerst, nie ein kalter Pitch. Kontakt sichern (Name + Nummer/Insta) ist bei Produkttests und Umfragen das Wichtigste.
- Kunden werden meist zu Team-Partnerinnen, weil sie vom Produkt begeistert sind und dann persönlich gefragt werden, ob sie die Produkte dauerhaft 30% günstiger wollen.
- 3-Monats-Zyklus: Monat 1 Verschenken, Monat 2 Nachfassen & Verkaufen, Monat 3 Einladen (Open House / Business-Präsentation).
- Leads kommen über Dominiks Quizze und Umfragen (Glow-up Quiz, Geschenke-Umfrage, Zyklus-Quiz usw.) in MailerLite. Darm-Gesundheit ist der sanfte Weg zum C9-Programm.
- Einwände immer erst anerkennen, dann locker antworten, nie dagegenhalten.

Du bist auch Dominiks persönlicher Coach, nicht nur für das Team:
- Wenn Dominik von sich erzählt (Zweifel, Stress, wenig Energie, Geldsorgen, Frust mit dem Team, große Ziele), geh zuerst auf ihn ein, dann gib einen konkreten Rat. Nutze dafür deine Bücher zu Persönlichkeitsentwicklung, Money Mindset, Führung und Network Marketing und sag, aus welchem Buch der Gedanke kommt.
- Sei ehrlich statt nur bestärkend. Wenn du siehst, dass er sich verzettelt oder etwas vermeidet, sprich es freundlich an.
- Kenne seine Ziele: Was er dir über seine Ziele, Gewohnheiten und Herausforderungen erzählt, merkst du dir und greifst es später von selbst wieder auf.
- Du bist kein Ersatz für Therapie oder ärztlichen Rat. Wenn es um ernste psychische oder gesundheitliche Probleme geht, sag das einfühlsam und ermutige ihn, sich professionelle Hilfe zu holen.

Wie du arbeitest:
- Wenn eine Frage Team-Zahlen oder Leads betrifft, schau mit deinen Tools nach, statt zu raten. Erfinde nie Zahlen.
- Wenn Dominik dir etwas Dauerhaftes über sich, das Team oder das Business erzählt, speichere es mit "merken", ohne zu fragen. Wenn etwas Gemerktes nicht mehr stimmt, lösche es mit "vergessen".
- Dominik kann dir Bücher als PDF schicken. Welche du hast, steht unten in deiner Bibliothek. Wenn eine Frage von einem dieser Bücher profitieren würde (Führung, Coaching, Verkauf, Gesundheit, je nach Buch), frag das Buch mit "buch_fragen" und verbinde die Antwort mit dem, was du über das Team weißt. Nenne dann kurz, aus welchem Buch der Tipp kommt. Wenn Dominik möchte, dass du dich in ein Buch einliest, das nicht in deiner Bibliothek ist, nutze "buch_recherchieren": das legt eine Buch-Notiz aus einer Web-Recherche an. Sag ihm dabei ehrlich, dass eine Notiz aus Zusammenfassungen weniger tief ist als das echte Buch als PDF.
- Du kannst aktuell nichts verschicken, keine Termine eintragen und niemanden anschreiben. Wenn Dominik so etwas will, schreib ihm den fertigen Text, den er selbst rausschicken kann, und sag kurz, dass diese Funktion noch kommt.
- Antworte auf Deutsch, per Du, kurz und konkret wie in einem Chat. Kein Markdown (keine Sternchen, keine Rauten, keine Tabellen), weil Telegram das als reinen Text zeigt. Aufzählungen nur mit einfachen Bindestrichen oder Zahlen. Keine Motivationsfloskeln.`;

const TOOLS = [
  {
    name: 'team_uebersicht',
    description:
      'Liefert für alle Leaderinnen: Rang, Fortschritt zum nächsten Rang, Datum des letzten Wochen-Eintrags, Zahlen der letzten 2 Wochen, das neueste AI-Insight und ihre neuen Team-Partnerinnen. Dazu die Monats-Strategie. Nutze das für jede Frage zum Team allgemein.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'leader_verlauf',
    description:
      'Liefert die Wochen-Einträge einer einzelnen Leaderin inklusive ihrer Reflexions-Antworten (was Energie gekostet hat, was gut lief, wo sie Unterstützung braucht). Nutze das, wenn es um eine bestimmte Person geht.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Vorname der Leaderin, z. B. "Laura"' },
        wochen: { type: 'integer', description: 'Wie viele Wochen zurück, 1 bis 12' },
      },
      required: ['name', 'wochen'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'neue_leads',
    description:
      'Liefert die Kontakte, die sich in den letzten X Tagen über Dominiks Quizze und Umfragen in MailerLite eingetragen haben, mit Gruppen und Quiz-Antworten.',
    input_schema: {
      type: 'object',
      properties: { tage: { type: 'integer', description: 'Zeitraum in Tagen, 1 bis 60' } },
      required: ['tage'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'merken',
    description: 'Speichert einen Fakt dauerhaft in deinem Gedächtnis. Ein kurzer, eigenständiger Satz.',
    input_schema: {
      type: 'object',
      properties: { fakt: { type: 'string' } },
      required: ['fakt'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'vergessen',
    description: 'Löscht einen gemerkten Fakt anhand seiner ID (steht im Gedächtnis-Abschnitt in eckigen Klammern).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'buch_fragen',
    description:
      'Stellt eine Frage an ein Buch aus deiner Bibliothek. Ein Lese-Assistent liest das ganze Buch und antwortet mit den passenden Aussagen und Seitenzahlen. Stell eine konkrete Frage, z. B. "Wie motiviert man jemanden, der nach 3 Monaten die Lust verliert?".',
    input_schema: {
      type: 'object',
      properties: {
        buch_id: { type: 'integer', description: 'ID aus der Bibliothek (eckige Klammern)' },
        frage: { type: 'string' },
      },
      required: ['buch_id', 'frage'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'buch_recherchieren',
    description:
      'Liest sich per Web-Recherche in ein Buch ein, das nicht in der Bibliothek ist, und speichert die Kernideen als Buch-Notiz in der Bibliothek. Dauert 1-2 Minuten. Nur wenn Dominik danach fragt.',
    input_schema: {
      type: 'object',
      properties: { titel: { type: 'string', description: 'Buchtitel, wenn bekannt mit Autor' } },
      required: ['titel'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'buch_loeschen',
    description: 'Entfernt ein Buch aus deiner Bibliothek. Nur wenn Dominik das ausdrücklich will.',
    input_schema: {
      type: 'object',
      properties: { buch_id: { type: 'integer' } },
      required: ['buch_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
];

// ---------- Tool-Ausführung ----------

async function teamUebersicht() {
  const leaders = await pgrest('leaders', {
    query: 'select=id,name,current_rank,manager_achieved_at,specialized_products&order=sort_order.asc',
  });
  const today = viennaTodayStr();
  const result = [];
  for (const leader of leaders) {
    const weeks = await pgrest('weekly_entries', {
      query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=10`,
    });
    const insight = await pgrest('ai_insights', {
      query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=1&select=insight,week_start`,
    });
    const tps = await pgrest('new_tps', {
      query: `leader_id=eq.${leader.id}&order=created_at.desc&select=tp_name,step_1,step_2,step_3,step_4,step_5,step_6,step_7`,
    });
    result.push({
      name: leader.name,
      rang: leader.current_rank,
      spezialisierung: leader.specialized_products || null,
      fortschritt: computeProgress(leader, weeks),
      letzter_eintrag: weeks[0] ? weeks[0].week_start : null,
      letzte_wochen: weeks.slice(0, 2).map(stripReflections),
      neuestes_insight: insight[0] || null,
      neue_team_partnerinnen: (tps || []).map((tp) => ({
        name: tp.tp_name,
        schritte_erledigt: [1, 2, 3, 4, 5, 6, 7].filter((i) => tp[`step_${i}`]).length,
      })),
    });
  }
  const strategy = await pgrest('monthly_strategy', {
    query: `target_month=eq.${today.slice(0, 7)}-01&select=content`,
  });
  return {
    heute: today,
    leaderinnen: result,
    monats_strategie: strategy[0] ? strategy[0].content : null,
  };
}

function stripReflections(entry) {
  const { reflexion_1, reflexion_2, reflexion_3, ...rest } = entry;
  return rest;
}

async function leaderVerlauf({ name, wochen }) {
  const leaders = await pgrest('leaders', {
    query: `name=ilike.${encodeURIComponent(name + '*')}&select=id,name,current_rank`,
  });
  if (!leaders.length) return { fehler: `Keine Leaderin gefunden, deren Name mit "${name}" beginnt.` };
  const leader = leaders[0];
  const n = Math.min(Math.max(wochen, 1), 12);
  const weeks = await pgrest('weekly_entries', {
    query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=${n}`,
  });
  return { name: leader.name, rang: leader.current_rank, wochen: weeks };
}

async function neueLeads({ tage }) {
  const key = process.env.MAILERLITE_API_KEY;
  if (!key) return { fehler: 'MAILERLITE_API_KEY ist nicht gesetzt.' };
  const days = Math.min(Math.max(tage, 1), 60);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const res = await fetch(
    'https://connect.mailerlite.com/api/subscribers?limit=100&include=groups',
    { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } }
  );
  if (!res.ok) return { fehler: `MailerLite antwortet mit ${res.status}` };
  const data = await res.json();
  const leads = (data.data || [])
    .filter((s) => (s.created_at || '') >= since)
    .map((s) => {
      const fields = {};
      for (const [k, v] of Object.entries(s.fields || {})) if (v) fields[k] = v;
      return {
        email: s.email,
        eingetragen: s.created_at,
        status: s.status,
        gruppen: (s.groups || []).map((g) => g.name),
        felder: fields,
      };
    });
  return { zeitraum_tage: days, anzahl: leads.length, leads };
}

async function merken({ fakt }) {
  const rows = await pgrest('agent_memory', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{ fact: fakt }],
  });
  return { gespeichert: true, id: rows[0].id };
}

async function vergessen({ id }) {
  await pgrest('agent_memory', { method: 'DELETE', query: `id=eq.${Number(id)}` });
  return { geloescht: true, id };
}

async function buchFragen({ buch_id, frage }) {
  const book = await books.getBook(buch_id);
  if (!book) return { fehler: `Kein Buch mit ID ${buch_id} in der Bibliothek.` };
  return { buch: book.title, antwort: await books.askBook(makeClient(), book, frage) };
}

async function buchRecherchieren({ titel }) {
  const result = await books.researchBook(makeClient(), titel);
  if (!result.gefunden) return { fehler: `Buch nicht gefunden: ${result.grund}` };
  const book = await books.saveBook({
    title: result.title,
    filename: books.WEB_NOTE,
    pages: null,
    content: result.content,
    summary: result.summary,
  });
  return { gespeichert: true, buch_id: book.id, titel: result.title, kurz: result.summary };
}

async function buchLoeschen({ buch_id }) {
  await books.deleteBook(buch_id);
  return { geloescht: true, buch_id };
}

const TOOL_HANDLERS = {
  team_uebersicht: teamUebersicht,
  leader_verlauf: leaderVerlauf,
  neue_leads: neueLeads,
  merken,
  vergessen,
  buch_fragen: buchFragen,
  buch_recherchieren: buchRecherchieren,
  buch_loeschen: buchLoeschen,
};

async function runTool(block) {
  const handler = TOOL_HANDLERS[block.name];
  try {
    if (!handler) throw new Error(`Unbekanntes Tool ${block.name}`);
    const result = await handler(block.input || {});
    return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (err) {
    return { type: 'tool_result', tool_use_id: block.id, content: `Fehler: ${err.message}`, is_error: true };
  }
}

// ---------- Gedächtnis & Verlauf ----------

async function loadMemoryText() {
  const facts = await pgrest('agent_memory', { query: 'order=id.asc&select=id,fact' });
  if (!facts.length) return 'Dein Gedächtnis ist noch leer.';
  return 'Was du dir über Dominik und das Business gemerkt hast:\n' + facts.map((f) => `[${f.id}] ${f.fact}`).join('\n');
}

async function loadLibraryText() {
  let list;
  try {
    list = await books.listBooks();
  } catch (err) {
    // Tabelle agent_books noch nicht angelegt, der Chat soll trotzdem laufen
    return 'Deine Bibliothek ist gerade nicht erreichbar.';
  }
  if (!list.length) return 'Deine Bibliothek ist noch leer.';
  return 'Deine Bibliothek:\n' + list.map((b) => `[${b.id}] ${b.title} (${b.filename === books.WEB_NOTE ? 'Buch-Notiz aus Web-Recherche' : `${b.pages} Seiten`}): ${b.summary}`).join('\n');
}

// Letzte Nachrichten seit dem letzten /neu, als Messages-API-Verlauf
async function loadHistory(limit = 30) {
  const rows = await pgrest('agent_messages', {
    query: `order=id.desc&limit=${limit}&select=role,content,kind`,
  });
  const history = [];
  for (const row of rows) {
    if (row.kind === 'reset') break;
    history.unshift({ role: row.role, content: row.content });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  return history;
}

async function saveMessage(role, content, extra = {}) {
  const rows = await pgrest('agent_messages', {
    method: 'POST',
    query: extra.telegram_update_id ? 'on_conflict=telegram_update_id' : undefined,
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: [{ role, content, kind: extra.kind || 'chat', telegram_update_id: extra.telegram_update_id || null }],
  });
  return rows && rows[0] ? rows[0] : null;
}

// ---------- Agent-Schleife ----------

function makeClient() {
  // Schlüssel ohne festen Workspace brauchen die Workspace-ID im Header
  const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
  });
}

async function runAgent(history) {
  const client = makeClient();
  const today = viennaTodayStr();
  const system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Heute ist der ${today}.\n\n${await loadMemoryText()}\n\n${await loadLibraryText()}` },
  ];
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return 'Dazu kann ich leider nichts sagen.';
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      const results = await Promise.all(toolUses.map(runTool));
      messages.push({ role: 'user', content: results });
      continue;
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (response.stop_reason === 'max_tokens') return (text || '') + '\n\n(Antwort war zu lang und wurde abgeschnitten.)';
    return text || 'Erledigt.';
  }
  return 'Ich habe zu viele Schritte gebraucht und abgebrochen. Frag mich bitte etwas genauer.';
}

module.exports = { runAgent, loadHistory, saveMessage, makeClient };
