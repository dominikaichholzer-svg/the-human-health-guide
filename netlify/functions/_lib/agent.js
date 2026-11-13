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
const { PANEL_WISDOM } = require('./panel-wisdom');
const { buildPdf } = require('./pdf');
const { sendDocument } = require('./telegram');
const flp = require('./flp');

// Zwei Modelle, um Kosten zu sparen: Haiku für normale Chat-Fragen, Sonnet
// für das Morgen-Briefing, tieferes Coaching, Analysen und alles, was eine
// Websuche braucht. Welches Modell eine Nachricht bekommt, entscheidet
// chooseModel() mit einem sehr kurzen Haiku-Aufruf.
const FAST_MODEL = 'claude-haiku-5-5';
const DEEP_MODEL = 'claude-sonnet-5-5';
const MAX_TOOL_ROUNDS = 15;

const SYSTEM_PROMPT = `Du bist JARVIS, der persönliche Business-Agent von Dominik. Dominik führt ein Forever-Living-Team (Aloe-Vera-Produkte, Direktvertrieb/Network-Marketing) mit 5 Leaderinnen. Dominik schreibt dir über Telegram, oft unterwegs vom Handy.

Was du über das Business weißt:
- Ziel der Leaderinnen: Manager-Rang bis 30.04.2027, danach das Eagle-Manager-Jahr bis 30.04.2028. Rangweg: Supervisor → Assistant Manager → Manager → Eagle Manager. "CC" ist das Umsatz-Volumen, "CC-Stand" das CC des laufenden Monats.
- Grundprinzip der Ansprache im Team: immer ein echtes, ehrliches Kompliment zuerst, nie ein kalter Pitch. Kontakt sichern (Name + Nummer/Insta) ist bei Produkttests und Umfragen das Wichtigste.
- Kunden werden meist zu Team-Partnerinnen, weil sie vom Produkt begeistert sind und dann persönlich gefragt werden, ob sie die Produkte dauerhaft 30% günstiger wollen.
- November 2026 ist ein Sondermonat: Fokus Weihnachtsgeschenke verkaufen, über die persönlichen Geschenke-Umfragen (geschenke-umfrage-<name>.html) mit 9 Sets in 3 Bereichen und 3 Größen.
- 3-Monats-Zyklus: Monat 1 Verschenken, Monat 2 Nachfassen & Verkaufen, Monat 3 Einladen (Open House / Business-Präsentation).
- Leads kommen über Dominiks Quizze und Umfragen (Glow-up Quiz, Geschenke-Umfrage, Zyklus-Quiz usw.) in MailerLite. Darm-Gesundheit ist der sanfte Weg zum C9-Programm.
- Einwände immer erst anerkennen, dann locker antworten, nie dagegenhalten.

Du bist auch Dominiks persönlicher Coach, nicht nur für das Team:
- Wenn Dominik von sich erzählt (Zweifel, Stress, wenig Energie, Geldsorgen, Frust mit dem Team, große Ziele), geh zuerst auf ihn ein, dann gib einen konkreten Rat. Nutze dafür deine Bücher zu Persönlichkeitsentwicklung, Money Mindset, Führung und Network Marketing und sag, aus welchem Buch der Gedanke kommt.
- Sei ehrlich statt nur bestärkend. Wenn du siehst, dass er sich verzettelt oder etwas vermeidet, sprich es freundlich an.
- Kenne seine Ziele: Was er dir über seine Ziele, Gewohnheiten und Herausforderungen erzählt, merkst du dir und greifst es später von selbst wieder auf.
- Du bist kein Ersatz für Therapie oder ärztlichen Rat. Wenn es um ernste psychische oder gesundheitliche Probleme geht, sag das einfühlsam und ermutige ihn, sich professionelle Hilfe zu holen.

Nachrichten, die mit [Sprachnachricht] beginnen, hat Dominik gesprochen und sie wurden automatisch in Text umgewandelt. Dabei können einzelne Wörter oder Namen falsch erkannt sein. Lies sie wohlwollend und frag nur nach, wenn der Sinn wirklich unklar ist.

Wie du arbeitest:
- Wenn eine Frage Team-Zahlen oder Leads betrifft, schau mit deinen Tools nach, statt zu raten. Erfinde nie Zahlen.
- Wenn Dominik dir etwas Dauerhaftes über sich, das Team oder das Business erzählt, speichere es mit "merken", ohne zu fragen. Wenn etwas Gemerktes nicht mehr stimmt, lösche es mit "vergessen".
- Dominik kann dir Bücher als PDF schicken. Welche du hast, steht unten in deiner Bibliothek. Wenn eine Frage von einem dieser Bücher profitieren würde (Führung, Coaching, Verkauf, Gesundheit, je nach Buch), frag das Buch mit "buch_fragen" und verbinde die Antwort mit dem, was du über das Team weißt. Nenne dann kurz, aus welchem Buch der Tipp kommt. Wenn Dominik möchte, dass du dich in ein Buch einliest, das nicht in deiner Bibliothek ist, nutze "buch_recherchieren": das legt eine Buch-Notiz aus einer Web-Recherche an. Sag ihm dabei ehrlich, dass eine Notiz aus Zusammenfassungen weniger tief ist als das echte Buch als PDF.
- Dominik kann dir den Downline-Export aus FLP360 als Excel-Datei schicken (alle Geschäftspartner mit Titel, Land, Generation und persönlichem CC der letzten 4 Monate, ohne Telefon und E-Mail). Für Fragen zu seiner ganzen Downline, z. B. wer inaktiv ist oder wer länger nicht bestellt hat, nutze "flp_partner". FBO sind alle Geschäftspartner mit Titel, FPC sind Preferred Customer. Fragt er nach dem Team oder allen Registrierten einer bestimmten Person, setz downline_von auf ihren Namen. Übernimm die Reihenfolge des Tools und nenne in der Antwort, von wann der Export ist. Bei langen Listen (mehr als etwa 30 Personen) ruf das Tool mit als_pdf=true auf, das PDF geht dann direkt an Dominik. Schreib im Chat nur noch die Anzahlen und deine Empfehlung, wen er zuerst kontaktieren sollte.
- Schulungswissen: Deine Bibliothek enthält Einträge mit dem Titel "Schulung: ...". Das sind die Videos der Basis-Ausbildung (More-Success-Academy), die jede neue Partnerin durchmacht: Warum, Empfehlungsmarketing, Kundenkonzepte (WhatsApp-Event, Wellness-Abend, Testboxen, Lips und Zahnpasta, C9), Vergütungsplan, Forever-Cockpit, indirekte Vermarktung, kalter Markt, Einwände, Trello, Social Media, Supervisor-Training, Monatsplanung. Bei Fragen zu Abläufen, Konzepten, Produkten, Vergütung, Rängen, Einwänden oder Vorgehen im Team schau ZUERST in die passenden Schulungs-Einträge und frag sie mit "buch_fragen" ab, bei Bedarf mehrere. Die Kurzfassung in der Bibliotheksliste reicht nicht. Bei Vergütung, Rängen, CC, Prozenten, Rabatten und Beträgen nennst du nur Zahlen, die im Schulungstext stehen, genau so wie dort genannt, ohne zu runden, zu ergänzen oder hochzurechnen. Trenne klar: "Laut Schulung (Titel): ..." für das, was im Video steht, und "Nicht aus der Schulung: ..." nur, wenn es nötig ist. Sprich von "Video" oder "Schulung", nicht von "Transkript". Steht etwas nicht in der Schulung, sag das ehrlich und verweise für Verbindliches auf das Forever-Cockpit oder die offiziellen Firmenunterlagen. Widersprechen sich zwei Videos, nenne beide Fundstellen. Nenne am Ende den Titel des Videos als Quelle. Die Videos kommen aus dem Schweizer Umfeld, Frankenbeträge und CC-Werte gelten dort "je nach Land": nenne sie als Beispiel aus der Schulung, nicht als Werte für Österreich. Was nur eingeblendet war (Tabellen, Länderwerte), fehlt im Text. Die Videos enthalten Gesundheits- und Einkommensaussagen (z. B. zu Neurodermitis oder Verdienstbeispiele). Nutze sie als Lerninhalt für Dominik, aber übernimm sie nie als Aussage in Texte, die an Kunden oder Interessenten gehen: dort nur "unterstützt", keine Heilversprechen, keine Einkommensversprechen.
- Du kannst Dominik mit "pdf_senden" ein PDF schicken. Wenn er nach einem PDF fragt, oder bei langen Plänen zum Nachschlagen, nutze das. Wenn er "das als PDF" sagt, nimm den Inhalt deiner letzten ausführlichen Antwort vollständig.
- Jede Leaderin hat einen monatlichen Entwicklungsplan (Schwerpunkt, Ziel, Schritte, Auswertung). Du schlägst ihn vor, sie bestätigt ihn, Dominik gibt Feedback. Er steht in team_details (entwicklungsplan).
- Du pflegst für jede Leaderin ein Entwicklungsprofil (Stärken, Muster, Wachstumsfelder mit Gesprächsidee), das jeden Sonntagabend aktualisiert wird. Du findest es in team_details (entwicklungsprofil) und die Wachstumsfelder in coaching_hinweise. Nutze es, wenn Dominik ein Gespräch vorbereitet oder fragt, wo jemand besser werden kann.
- Seit Phase 3 und 4 des Leader-Dashboards hast du Werkzeuge für "Mein Team" der Leaderinnen (team_details), Coaching-Hinweise (coaching_hinweise), Pins und die vier Rankings (pins_und_rankings) und die 52-Wochen-Challenge (challenge_antworten). Die Rankings sind vier getrennte Blickwinkel, rechne sie nie zu einer Gesamtpunktzahl zusammen. Die Coaching-Notizen der Leaderinnen sind vertraulich: nutze sie für Dominiks Vorbereitung, schlag nie vor, sie weiterzugeben.
- Du triffst nie Entscheidungen über Menschen. Du sagst nicht, ob jemand "es schafft", sich lohnt oder fallen gelassen werden sollte. Du gibst Beobachtungen, Fragen und Gesprächsideen, entscheiden tut Dominik.
- Du kannst sonst nichts verschicken, keine Termine eintragen und niemanden anschreiben. Wenn Dominik so etwas will, schreib ihm den fertigen Text, den er selbst rausschicken kann, und sag kurz, dass diese Funktion noch kommt.
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
    name: 'flp_partner',
    description:
      'Liest den neuesten FLP360-Downline-Export, den Dominik geschickt hat. Liefert die Geschäftspartner als Zeilen, sortiert nach letzter Bestellung (jüngste zuerst). Mit nur_inaktive=true nur die, die in den letzten "monate_ohne_cc" Monaten des Exports kein persönliches CC hatten (1 = nur der aktuelle Monat).',
    input_schema: {
      type: 'object',
      properties: {
        typ: { type: 'string', enum: ['fbo', 'fpc', 'alle'], description: 'fbo = Geschäftspartner mit Titel, fpc = Preferred Customer' },
        nur_inaktive: { type: 'boolean' },
        monate_ohne_cc: { type: 'integer', description: '1 bis 4, Standard 1' },
        downline_von: { type: 'string', description: 'Name einer Person, z. B. "Sarah Blenke": dann nur ihre komplette Downline (alle unter ihr, sie selbst nicht). Leer lassen für die ganze Downline von Dominik.' },
        als_pdf: { type: 'boolean', description: 'true: das Tool baut aus der kompletten Liste selbst ein PDF und schickt es Dominik. Nimm das bei langen Listen, statt sie mit pdf_senden abzuschreiben.' },
      },
      required: ['typ', 'nur_inaktive', 'monate_ohne_cc', 'downline_von', 'als_pdf'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'pdf_senden',
    description:
      'Erstellt ein übersichtliches PDF und schickt es Dominik direkt in Telegram. Nutze das, wenn Dominik ein PDF oder Dokument möchte, oder für lange Pläne, die er immer wieder nachschlagen will. Schreib den vollständigen Inhalt in "inhalt", nicht nur eine Zusammenfassung. Format: "# " für große Überschriften (z. B. pro Person), "## " für Zwischenüberschriften, "- " für Aufzählungen, "> " vor fertigen Nachrichten zum Kopieren (z. B. WhatsApp-Texte), Leerzeile für neue Absätze. Keine Emojis, keine Tabellen.',
    input_schema: {
      type: 'object',
      properties: {
        titel: { type: 'string', description: 'Kurzer Titel, steht oben im PDF und im Dateinamen' },
        inhalt: { type: 'string' },
      },
      required: ['titel', 'inhalt'],
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
  {
    name: 'coaching_hinweise',
    description:
      'Liefert alle aktuellen Hinweise auf Coaching-Bedarf: zu jeder Leaderin (viele Kontakte aber kaum Präsentationen, Tage ohne Tagesabschluss, Plan im Vormonat verfehlt, liegt hinter dem laufenden Monatsplan) und zu den Partnerinnen in ihrem Team (CC sinkt, Einarbeitung hängt, Ziel bald fällig). Nutze das fürs Morgen-Briefing und wenn Dominik fragt, wo er sich kümmern sollte.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: 'team_details',
    description:
      'Liefert für eine Leaderin ihr ganzes "Mein Team": Partnerinnen mit Sponsor, Rang, CC der letzten Monate, Einarbeitung, Entwicklungszielen, Hinweisen und den Coaching-Notizen der Leaderin; dazu Dominiks eigene Notizen zu ihr. Nutze das, wenn es um das Team einer bestimmten Leaderin oder ein Gespräch mit ihr geht.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Vorname der Leaderin, z. B. "Laura"' } },
      required: ['name'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'pins_und_rankings',
    description:
      'Liefert für einen Monat die vier getrennten Rankings (persönliche CC, Call-Teilnahme, Eigenverbrauch, 4CC-Leaderentwicklung) und die Leadership-Pins (vergeben oder Vorschlag mit Begründung). Die Rankings sind nur für Dominik, nie zu einer Gesamtpunktzahl zusammenrechnen.',
    input_schema: {
      type: 'object',
      properties: { monat: { type: 'string', description: 'Monat als JJJJ-MM, z. B. "2026-11". Leer = Vormonat.' } },
      required: ['monat'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'challenge_antworten',
    description:
      'Liefert eine Woche der 52-Wochen-Leadership-Challenge: Impuls, Aufgabe, Reflexionsfrage und je Leaderin, ob die Aufgabe erledigt ist und ihre Antwort.',
    input_schema: {
      type: 'object',
      properties: { woche: { type: 'integer', description: 'Wochennummer 1 bis 52, 0 = laufende Woche' } },
      required: ['woche'],
      additionalProperties: false,
    },
    strict: true,
  },
  { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
];

// ---------- Phase 4: Teamführung, Pins, Rankings, Challenge ----------

const { loadTeams } = require('./team');
const { memberSignals, leaderSignals } = require('./signals');
const { planStatus } = require('./leader-context');
const { latestProfiles } = require('./profile');
const challenge = require('./challenge');
const { monthsBack, monthlyTotals } = require('./ranks');

async function leaderSignalsFor(leader, today) {
  const [weeks, days, prevPlans, curPlans] = await Promise.all([
    pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&order=week_start.desc&limit=10&select=*` }),
    pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&order=entry_date.desc&limit=7&select=entry_date` }).catch(() => []),
    pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=eq.${monthsBack(today, 2)[0]}-01&select=target_month,plan_cc` }).catch(() => []),
    pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=eq.${today.slice(0, 7)}-01&select=plan_cc` }).catch(() => []),
  ]);
  const out = leaderSignals({ weeks, days, plans: prevPlans }, today).map((x) => x.text);
  if (curPlans && curPlans[0]) {
    const st = planStatus(Number(curPlans[0].plan_cc), monthlyTotals(weeks || [])[today.slice(0, 7)], today);
    if (st && st.behind) out.push(`Liegt hinter dem Monatsplan: noch ${st.remaining} CC in ${st.daysLeft} Tagen`);
  }
  return out;
}

async function coachingHinweise() {
  const today = viennaTodayStr();
  const leaders = await pgrest('leaders', { query: 'select=id,name&order=sort_order.asc' });
  let teams = null;
  try { teams = await loadTeams(leaders.map((l) => l.id), today, { coaching: true }); } catch (e) { teams = null; }
  const result = [];
  for (const l of leaders) {
    const team = [];
    if (teams) {
      for (const m of teams.byLeader[l.id].members) {
        const sig = memberSignals(m, teams.ccMonth, today);
        if (sig.length) team.push({ partnerin: m.name, hinweise: sig.map((x) => x.text) });
      }
    }
    result.push({ leaderin: l.name, hinweise_zu_ihr: await leaderSignalsFor(l, today), hinweise_zu_ihrem_team: team });
  }
  // Wachstumsfelder aus den JARVIS-Entwicklungsprofilen
  try {
    const profiles = await latestProfiles(leaders.map((l) => l.id));
    for (const r of result) {
      const l = leaders.find((x) => x.name === r.leaderin);
      const p = l && profiles[l.id];
      if (p) r.wachstumsfelder = (p.wachstumsfelder || []).map((w) => `${w.feld} (Gesprächsidee: ${w.gespraechsidee})`);
    }
  } catch (e) { /* Profile noch nicht eingerichtet */ }
  return { heute: today, leaderinnen: result };
}

async function teamDetails({ name }) {
  const today = viennaTodayStr();
  const rows = await pgrest('leaders', { query: `name=ilike.${encodeURIComponent(name + '*')}&select=id,name,current_rank` });
  if (!rows.length) return { fehler: `Keine Leaderin mit dem Namen ${name} gefunden.` };
  const l = rows[0];
  const teams = await loadTeams([l.id], today, { coaching: true });
  // Mitlesen der Coaching-Notizen wird protokolliert, wie im Admin-Dashboard
  try {
    await pgrest('access_log', { method: 'POST', body: [{ leader_id: l.id, action: 'jarvis_read_coaching_notes', detail: 'Telegram' }] });
  } catch (e) { /* Protokoll darf nichts blockieren */ }
  let adminNotes = [];
  try {
    adminNotes = await pgrest('coaching_notes', { query: `leader_id=eq.${l.id}&author=eq.admin&order=created_at.desc&limit=10&select=note,created_at` });
  } catch (e) { adminNotes = []; }
  const members = teams.byLeader[l.id].members;
  const byId = Object.fromEntries(members.map((m) => [m.id, m.name]));
  let profil = null;
  try { profil = (await latestProfiles([l.id]))[l.id] || null; } catch (e) { profil = null; }
  let entwicklungsplan = null;
  try { entwicklungsplan = await require('./devplan').leaderPlans(l.id, today); } catch (e) { entwicklungsplan = null; }
  return {
    leaderin: l.name,
    rang: l.current_rank,
    entwicklungsprofil: profil,
    entwicklungsplan,
    cc_monat: teams.ccMonth,
    team_cc: teams.byLeader[l.id].totals,
    hinweise_zu_ihr: await leaderSignalsFor(l, today),
    deine_notizen_zu_ihr: adminNotes.map((n) => ({ datum: String(n.created_at).slice(0, 10), notiz: n.note })),
    partnerinnen: members.map((m) => ({
      name: m.name, aktiv: m.active, rang: m.rank, gesponsert_von: m.sponsorId ? byId[m.sponsorId] || null : l.name,
      dabei_seit: m.startDate, warum: m.warum, cc: m.cc, fortschritt: m.progress,
      einarbeitung: m.onboarding ? `${m.onboarding.done}/7` : null,
      ziele: (m.goals || []).map((g) => ({ ziel: g.goal, bis: g.targetDate, status: g.status, naechster_schritt: g.nextStep, fortschritt_prozent: g.progress ? g.progress.pct : null })),
      hinweise: memberSignals(m, teams.ccMonth, today).map((x) => x.text),
      notizen_der_leaderin: (m.notes || []).slice(0, 5).map((n) => ({ datum: String(n.createdAt).slice(0, 10), notiz: n.note })),
    })),
  };
}

async function pinsUndRankings({ monat }) {
  const { computeRankings } = require('../admin-rankings');
  const { computePins } = require('../admin-pins');
  const [r, p] = await Promise.all([computeRankings(monat), computePins(monat).catch(() => null)]);
  return {
    monat: r.month,
    rankings: r.rankings.map((x) => ({ titel: x.title, einheit: x.unit, liste: x.rows.map((row) => ({ platz: row.place, name: row.name, wert: row.value, detail: row.detail || undefined })) })),
    pins: p ? p.leaders.map((l) => ({
      name: l.name,
      vergeben: l.awarded ? `${l.awarded.label} (${l.awarded.reason || ''})` : null,
      vorschlag: l.proposal ? (l.pins.find((x) => x.key === l.proposal) || {}).label : null,
      erfuellt: l.pins.filter((x) => x.ok).map((x) => `${x.label}: ${x.reason}`),
    })) : 'Pins noch nicht eingerichtet',
  };
}

async function challengeAntworten({ woche }) {
  const current = challenge.weekNoFor(viennaTodayStr());
  const n = woche && woche > 0 ? woche : current;
  if (n < 1 || n > challenge.WEEKS) return { hinweis: current < 1 ? `Die Challenge startet am ${challenge.START}.` : 'Diese Woche gibt es nicht.' };
  const [content, progress, leaders] = await Promise.all([
    pgrest('challenge_weeks', { query: `week_no=eq.${n}&select=impuls,aufgabe,frage` }),
    pgrest('challenge_progress', { query: `week_no=eq.${n}&select=leader_id,task_done,answer` }),
    pgrest('leaders', { query: 'select=id,name&order=sort_order.asc' }),
  ]);
  return {
    woche: n,
    ab: challenge.weekStartOf(n),
    laufende_woche: current,
    inhalt: content[0] || null,
    leaderinnen: leaders.map((l) => {
      const p = progress.find((x) => x.leader_id === l.id);
      return { name: l.name, aufgabe_erledigt: !!(p && p.task_done), antwort: p && p.answer ? p.answer : null };
    }),
  };
}

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

async function pdfSenden({ titel, inhalt }) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { fehler: 'TELEGRAM_CHAT_ID ist nicht gesetzt.' };
  const buffer = await buildPdf(titel, inhalt);
  const slug = titel
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'jarvis';
  await sendDocument(chatId, buffer, `${slug}-${viennaTodayStr()}.pdf`, titel);
  return { gesendet: true, hinweis: 'Das PDF ist schon bei Dominik. Schreib ihm nur noch einen kurzen Satz dazu, nicht den Inhalt nochmal.' };
}

async function flpPartner({ als_pdf, ...filter }) {
  const result = await flp.partnerList(filter);
  if (result.fehler) return result;
  const { _rows, ...rest } = result;
  if (!als_pdf) return rest;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { fehler: 'TELEGRAM_CHAT_ID ist nicht gesetzt.' };
  const art = filter.nur_inaktive ? 'Inaktive Partner' : 'Partner';
  const team = filter.downline_von && filter.downline_von.trim() ? ` im Team von ${filter.downline_von.trim()}` : '';
  const titel = `${art} ${filter.typ === 'alle' ? 'FBO und FPC' : filter.typ.toUpperCase()}${team}`;
  const datei = `${art}${team}`.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-');
  const buffer = await buildPdf(titel, flp.pdfText(result));
  await sendDocument(chatId, buffer, `${datei}-${viennaTodayStr()}.pdf`, titel);
  return {
    pdf_gesendet: true,
    hinweis: 'Das PDF mit der kompletten Liste ist schon bei Dominik. Schreib ihm nur die Anzahlen und deine Empfehlung, nicht die ganze Liste.',
    ...rest,
    partner: rest.partner.slice(0, 40),
    weitere_im_pdf: Math.max(0, rest.partner.length - 40),
  };
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
  pdf_senden: pdfSenden,
  flp_partner: flpPartner,
  buch_loeschen: buchLoeschen,
  coaching_hinweise: coachingHinweise,
  team_details: teamDetails,
  pins_und_rankings: pinsUndRankings,
  challenge_antworten: challengeAntworten,
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
  return 'Deine Bibliothek:\n' + list.map((b) => `[${b.id}] ${b.title} (${b.filename === books.WEB_NOTE ? 'Buch-Notiz aus Web-Recherche' : books.isSchulung(b) ? 'Schulungsvideo' : `${b.pages} Seiten`}): ${b.summary}`).join('\n');
}

// Letzte Nachrichten seit dem letzten /neu, als Messages-API-Verlauf
async function loadHistory(limit = 20) {
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

const ROUTER_SCHEMA = {
  type: 'object',
  properties: { modell: { type: 'string', enum: ['einfach', 'tief'] } },
  required: ['modell'],
  additionalProperties: false,
};

// Bei Fehlern lieber das stärkere Modell nehmen als falsch sparen
async function chooseModel(client, text) {
  try {
    const response = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: 1000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ROUTER_SCHEMA } },
      messages: [
        {
          role: 'user',
          content: `Ordne diese Nachricht an einen Business-Assistenten ein.
"einfach": kurze Fragen, Zahlen oder Leads nachschauen, etwas merken, kurze Texte, Smalltalk, Danke, Bestätigungen.
"tief": persönliches Coaching (Zweifel, Motivation, Konflikte), Strategie und Planung, Analysen über mehrere Leaderinnen, Listen oder Auswertungen aus dem FLP-Export, längere Texte, PDFs oder Dokumente erstellen, Fragen an Bücher, alles was aktuelle Infos aus dem Internet braucht, Bücher recherchieren.

Nachricht: ${text.slice(0, 2000)}`,
        },
      ],
    });
    const json = response.content.find((b) => b.type === 'text');
    return JSON.parse(json.text).modell === 'einfach' ? FAST_MODEL : DEEP_MODEL;
  } catch (err) {
    console.error('chooseModel', err.message);
    return DEEP_MODEL;
  }
}

// Haiku kennt die Websuche mit Filterung nicht, darum bekommt nur Sonnet sie
function toolsFor(model) {
  return model === DEEP_MODEL ? TOOLS : TOOLS.filter((t) => t.name !== 'web_search');
}

// options.deep erzwingt Sonnet (z. B. fürs Morgen-Briefing)
async function runAgent(history, options = {}) {
  const client = makeClient();
  const today = viennaTodayStr();
  const system = [
    { type: 'text', text: SYSTEM_PROMPT + '\n\n' + PANEL_WISDOM, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Heute ist der ${today}.\n\n${await loadMemoryText()}\n\n${await loadLibraryText()}` },
  ];
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  let model = options.deep || !lastUser ? DEEP_MODEL : await chooseModel(client, lastUser.content);
  // Server-Fallback bei Ablehnung gibt es nur für Sonnet, nicht für Haiku
  const paramsFor = (m) =>
    m === DEEP_MODEL ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        ...paramsFor(model),
        output_config: { effort: 'medium' },
        // Automatisches Caching bis zur letzten Nachricht: die nächste Frage
        // im selben Gespräch liest Systemprompt und Verlauf dann fast zum
        // Zehntel des Preises
        cache_control: { type: 'ephemeral' },
        system,
        tools: toolsFor(model),
        messages,
      });
    } catch (err) {
      // Lehnt Haiku die Anfrage gleich zu Beginn ab, einfach mit Sonnet
      // weitermachen statt Dominik einen Fehler zu zeigen. Guthaben- oder
      // Schlüsselfehler gelten für beide Modelle, die werden durchgereicht.
      if (model === FAST_MODEL && round === 0 && err.status === 400 && !/credit balance/i.test(err.message)) {
        console.error('Haiku abgelehnt, wechsle zu Sonnet:', err.message);
        model = DEEP_MODEL;
        round--;
        continue;
      }
      throw err;
    }

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

module.exports = { runAgent, loadHistory, saveMessage, makeClient, _toolHandlers: TOOL_HANDLERS };
