// netlify/functions/_lib/support.js
//
// Schritt 4: Die Leaderin führt ihr Team.
//   supportList   "Wer braucht gerade Unterstützung?" Rein rechnerisch aus Mein Team:
//                 Hinweise (Ziel fällig, Einarbeitung hängt, CC sinkt), lange keine
//                 Coaching-Notiz (bei Neuen früher), Einarbeitung nicht gestartet, kein Ziel.
//   teamPattern   "Viele aktive Partnerinnen, aber wenig Coaching" (Anteil mit Notiz in 30 Tagen)
//   focusFor      JARVIS schlägt für EINE Partnerin einen Coaching-Schwerpunkt vor.
//                 Die Leaderin übernimmt ihn als Ziel oder Notiz, oder verwirft ihn.
// Grundlage sind nur die Daten der Leaderin selbst (Mein Team, ihre Notizen und Ziele).
// Dominiks Notizen fließen nie ein.

const { pgrest } = require('./supabase');
const { daysBetween, viennaTodayStr } = require('./ranks');
const { loadTeams } = require('./team');
const { memberSignals } = require('./signals');

const MODEL = 'claude-sonnet-5-5';
const NEW_DAYS = 90;          // so lange gilt eine Partnerin als "neu"
const NOTE_GAP_NEW = 14;      // Neue: nach 14 Tagen ohne Notiz melden
const NOTE_GAP = 30;          // alle anderen: nach 30 Tagen
const PATTERN_MIN_ACTIVE = 3;
const PATTERN_SHARE = 1 / 3;

// Gemerkte JARVIS-Vorschläge zählen nicht als Coaching-Kontakt
const JARVIS_NOTE = 'Coaching-Schwerpunkt (JARVIS):';
const lastNoteDate = (m) => (m.notes || []).filter((n) => !String(n.note || '').startsWith(JARVIS_NOTE)).reduce((a, n) => { const d = String(n.createdAt).slice(0, 10); return !a || d > a ? d : a; }, null);

function supportList(members, ccMonth, today) {
  const out = [];
  for (const m of members || []) {
    if (!m.active) continue;
    const reasons = [];
    let score = 0;
    for (const s of memberSignals(m, ccMonth, today)) { reasons.push(s.text); score += 3; }
    const isNew = m.startDate && daysBetween(m.startDate, today) <= NEW_DAYS;
    if (isNew && !m.onboarding) { reasons.push(`Neu dabei seit ${m.startDate.split('-').reverse().join('.')}, Einarbeitung noch nicht gestartet`); score += 2; }
    const last = lastNoteDate(m);
    const gap = last ? daysBetween(last, today) : null;
    if (last == null) { reasons.push('Noch keine Coaching-Notiz'); score += isNew ? 3 : 2; }
    else if (gap >= (isNew ? NOTE_GAP_NEW : NOTE_GAP)) { reasons.push(`Seit ${gap} Tagen keine Coaching-Notiz`); score += isNew ? 3 : 2; }
    if (!(m.goals || []).some((g) => g.status === 'open')) { reasons.push('Kein offenes Entwicklungsziel'); score += 1; }
    if (score >= 2) out.push({ id: m.id, name: m.name, rank: m.rank, score, reasons, lastNote: last, isNew: !!isNew });
  }
  return out.sort((a, b) => b.score - a.score || (a.lastNote || '').localeCompare(b.lastNote || '') || a.name.localeCompare(b.name));
}

function teamPattern(members, today) {
  const active = (members || []).filter((m) => m.active);
  if (active.length < PATTERN_MIN_ACTIVE) return null;
  const coached = active.filter((m) => { const d = lastNoteDate(m); return d && daysBetween(d, today) <= 30; }).length;
  if (coached / active.length >= PATTERN_SHARE) return null;
  return {
    active: active.length,
    coached,
    text: coached
      ? `${active.length} aktive Partnerinnen, aber nur bei ${coached} eine Coaching-Notiz in den letzten 30 Tagen.`
      : `${active.length} aktive Partnerinnen, aber in den letzten 30 Tagen keine Coaching-Notiz.`,
    tip: 'Plane diese Woche 2 kurze Gespräche mit Partnerinnen aus dieser Liste und halte danach in einem Satz fest, was ihr nächster Schritt ist.',
  };
}

const FOCUS_SCHEMA = {
  type: 'object',
  properties: {
    datenlage: { type: 'string', enum: ['gut', 'duenn'] },
    schwerpunkt: { type: 'string', description: 'EIN Coaching-Schwerpunkt für die nächsten Wochen, kurz' },
    warum: { type: 'string', description: 'Beleg aus den Daten, 1 bis 2 Sätze, an die Leaderin in Du-Form' },
    ziel: { type: 'string', description: 'Entwicklungsziel der Partnerin, kurz, so formuliert, dass es als Ziel gespeichert werden kann' },
    naechster_schritt: { type: 'string', description: 'Der nächste konkrete Schritt der Partnerin (nicht der Leaderin)' },
    gespraechsfrage: { type: 'string', description: 'EINE offene Frage, mit der die Leaderin das Gespräch beginnt, damit die Partnerin selbst ihren Weg findet' },
  },
  required: ['datenlage', 'schwerpunkt', 'warum', 'ziel', 'naechster_schritt', 'gespraechsfrage'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, Coach für die Leaderinnen in Dominiks Forever-Living-Team. Eine Leaderin fragt dich, worauf sie sich beim Coaching einer Partnerin konzentrieren soll.
Ziel: Die Partnerin lernt, sich selbst zu führen. Die Leaderin begleitet, statt ihr alles abzunehmen.
Regeln:
- Nur was in den Daten steht. Nenne den Beleg. Erfinde keine Gründe, Gefühle oder Lebensumstände.
- Sind die Daten dünn (kaum Notizen, kein Warum, kein Ziel), sag das ehrlich (datenlage "duenn") und schlage als Schwerpunkt ein Gespräch vor, in dem die Leaderin ihr Warum und ihr eigenes Ziel erfragt.
- EIN Schwerpunkt, passend zu Rang und Phase (neu: Einarbeitung und erste Erfolge; länger dabei: eigenes Ziel, Konstanz, eigene Partnerinnen).
- Ziel und nächster Schritt gehören der Partnerin und sind konkret und machbar. Die Gesprächsfrage ist offen und führt sie zu ihrer eigenen Antwort.
- Keine Bewertung der Person, keine Gesundheits- oder Einkommensversprechen.
- Deutsch, Du-Form an die Leaderin, kurze Sätze, keine Bindestriche als Satzverbinder.`;

async function focusFor(client, leader, memberId, todayStr) {
  const today = todayStr || viennaTodayStr();
  const t = await loadTeams([leader.id], today, { coaching: true });
  const members = t.byLeader[leader.id].members;
  const m = members.find((x) => x.id === memberId);
  if (!m) throw new Error('Partnerin nicht gefunden');
  const byId = Object.fromEntries(members.map((x) => [x.id, x.name]));
  const support = supportList([m], t.ccMonth, today)[0];
  const data = {
    partnerin: m.name,
    rang: m.rank,
    aktiv: m.active,
    dabei_seit: m.startDate,
    warum: m.warum,
    gesponsert_von: m.sponsorId ? byId[m.sponsorId] || null : 'der Leaderin selbst',
    eigene_partnerinnen: members.filter((x) => x.sponsorId === m.id && x.active).length,
    einarbeitung: m.onboarding ? `${m.onboarding.done}/7 Schritte` : 'nicht gestartet',
    cc_je_monat: Object.keys(m.cc || {}).length ? m.cc : 'nicht eingetragen (steht in FLP360)',
    ziele: (m.goals || []).map((g) => ({ ziel: g.goal, bis: g.targetDate, status: g.status, naechster_schritt: g.nextStep })),
    notizen_der_leaderin: (m.notes || []).slice(0, 8).map((n) => ({ datum: String(n.createdAt).slice(0, 10), notiz: String(n.note).slice(0, 400) })),
    hinweise: support ? support.reasons : [],
  };
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: FOCUS_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Leaderin: ${leader.name}, Rang ${leader.current_rank}. Heute: ${today}.\nDaten zur Partnerin:\n${JSON.stringify(data)}` }],
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Keine Antwort');
  const r = JSON.parse(block.text);
  return { memberId: m.id, memberName: m.name, ...r };
}

// Für den Chat der Leaderin und Dominiks Hinweise: kurz als Text
function supportSummary(members, ccMonth, today) {
  const list = supportList(members, ccMonth, today).slice(0, 3);
  const pattern = teamPattern(members, today);
  return { list, pattern };
}

module.exports = { supportList, teamPattern, supportSummary, focusFor, FOCUS_SCHEMA };
