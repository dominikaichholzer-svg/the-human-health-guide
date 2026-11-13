// netlify/functions/_lib/profile.js
//
// JARVIS-Entwicklungsprofil je Leaderin. Jede Woche liest JARVIS die Daten
// der letzten 4 Wochen und sein LETZTES Profil und schreibt ein aktualisiertes
// (so "lernt" er über die Wochen dazu). Ergebnis in leader_profiles.
//
// Drei Sichten in einem Profil:
//   - für Dominik: Stärken, Muster, Wachstumsfelder mit Beleg und Gesprächsidee
//   - für die Leaderin: ermutigend, "Deine Stärken" + "Dein nächster Wachstumsschritt"
//   - für den Leader-Chat: Hinweise, wie JARVIS sie am besten unterstützt
// Dominiks eigene Notizen fließen ein, werden aber nie in die Sicht der
// Leaderin oder die Chat-Hinweise übernommen.

const { pgrest } = require('./supabase');
const { viennaTodayStr, monthsBack, monthlyTotals } = require('./ranks');
const { weekNoFor } = require('./challenge');

const MODEL = 'claude-sonnet-5-5';
const WEEKS_BACK = 4;
const cut = (t, n) => (t == null ? null : String(t).slice(0, n));

const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    zusammenfassung: { type: 'string', description: 'Zwei Sätze: wo sie gerade steht' },
    staerken: { type: 'array', items: { type: 'string' }, description: '2 bis 4 Stärken, jeweils mit kurzem Beleg aus den Daten' },
    muster: { type: 'array', items: { type: 'string' }, description: '0 bis 3 wiederkehrende Muster über die Wochen' },
    wachstumsfelder: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          feld: { type: 'string' },
          beobachtung: { type: 'string', description: 'Beleg aus den Daten' },
          gespraechsidee: { type: 'string', description: 'Eine offene Frage oder Idee für Dominiks nächstes Gespräch' },
        },
        required: ['feld', 'beobachtung', 'gespraechsidee'],
        additionalProperties: false,
      },
      description: '1 bis 2 Wachstumsfelder',
    },
    veraenderung: { type: 'string', description: 'Was sich seit dem letzten Profil verändert hat, oder "Erstes Profil"' },
    fuer_leaderin: {
      type: 'object',
      properties: {
        staerken: { type: 'array', items: { type: 'string' }, description: '2 bis 3 Stärken, ermutigend in Du-Form' },
        naechster_schritt: { type: 'string', description: 'EIN konkreter, machbarer Wachstumsschritt für die nächste Woche, ermutigend in Du-Form' },
      },
      required: ['staerken', 'naechster_schritt'],
      additionalProperties: false,
    },
    chat_hinweise: { type: 'string', description: 'Für JARVIS im Chat der Leaderin: wie er sie am besten unterstützt. Ohne Dominiks Notizen.' },
    datenlage: { type: 'string', enum: ['gut', 'duenn', 'keine'] },
  },
  required: ['zusammenfassung', 'staerken', 'muster', 'wachstumsfelder', 'veraenderung', 'fuer_leaderin', 'chat_hinweise', 'datenlage'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, der Business-Coach in Dominiks Forever-Living-Team. Du pflegst für jede Leaderin ein Entwicklungsprofil, das Dominik beim Coaching hilft. Du bekommst dein letztes Profil und die neuen Daten. Aktualisiere das Profil: behalte, was sich bestätigt, ändere, was die neuen Daten widerlegen, und benenne Veränderungen.

Regeln:
- Nur Beobachtungen, die sich auf die Daten stützen. Nenne zu jeder Stärke und jedem Wachstumsfeld einen kurzen Beleg (Zahl, Datum oder ihre eigenen Worte). Erfinde nichts. Sind die Daten dünn, sag das und halte das Profil knapp.
- Du bewertest keine Menschen. Keine Urteile über ihren Wert, ob sie "es schafft", keine psychologischen Diagnosen, keine Gesundheitsaussagen. Du beschreibst Verhalten und Muster und schlägst Fragen vor. Entscheidungen trifft Dominik.
- Wachstumsfelder sind konkret und machbar (z. B. "Nachfassen nach dem Erstkontakt", nicht "mehr Disziplin").
- fuer_leaderin ist für die Leaderin selbst: warm, ermutigend, Du-Form, kein Vergleich mit anderen, nichts aus Dominiks Notizen, keine Muster, die verletzen könnten.
- chat_hinweise sind für dich selbst im Chat mit ihr: wie du sie am besten unterstützt (z. B. "braucht konkrete Formulierungen fürs Nachfassen"). Nichts aus Dominiks Notizen.
- Deutsch, kurz und klar, keine Bindestriche als Satzverbinder.`;

// Daten der letzten Wochen einer Leaderin, kompakt als Text
async function gatherInput(leader, todayStr) {
  const today = todayStr || viennaTodayStr();
  const since = new Date(Date.parse(today + 'T00:00:00Z') - WEEKS_BACK * 7 * 86400000).toISOString().slice(0, 10);
  const safe = async (p) => { try { return (await p) || []; } catch (e) { return []; } };
  const [days, weeks, plans, actuals, chal, notes, team, prev] = await Promise.all([
    safe(pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=gte.${since}&order=entry_date.asc&select=entry_date,kontakte_heute,verkaeufe_heute,stimmung,gut,schwer,morgen` })),
    safe(pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&week_start=gte.${monthsBack(today, 2)[0]}-01&order=week_start.asc&select=*` })),
    safe(pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=gte.${monthsBack(today, 2)[0]}-01&select=target_month,plan_cc,sponsoring_cc,eigen_cc,kunden_cc,kunden_text` })),
    safe(pgrest('monthly_actuals', { query: `leader_id=eq.${leader.id}&order=month.desc&limit=2&select=*` })),
    safe(pgrest('challenge_progress', { query: `leader_id=eq.${leader.id}&week_no=gte.${Math.max(1, weekNoFor(today) - WEEKS_BACK)}&select=week_no,task_done,answer` })),
    safe(pgrest('coaching_notes', { query: `leader_id=eq.${leader.id}&author=eq.admin&order=created_at.desc&limit=5&select=note,created_at` })),
    safe(pgrest('team_members', { query: `leader_id=eq.${leader.id}&active=eq.true&select=id` })),
    safe(pgrest('leader_profiles', { query: `leader_id=eq.${leader.id}&order=created_at.desc&limit=1&select=data,created_at` })),
  ]);
  const totals = monthlyTotals(weeks);
  const lines = [];
  lines.push(`Leaderin: ${leader.name}, Rang ${leader.current_rank}. Heute: ${today}. Zeitraum: seit ${since}.`);
  lines.push(`Aktive Partnerinnen in "Mein Team": ${team.length}.`);
  for (const p of plans) {
    const k = String(p.target_month).slice(0, 7);
    lines.push(`Monatsplan ${k}: ${p.plan_cc} CC (Sponsern ${p.sponsoring_cc ?? '–'}, Eigen ${p.eigen_cc ?? '–'}, Kunden ${p.kunden_cc ?? '–'}${p.kunden_text ? `, Konzept: ${cut(p.kunden_text, 200)}` : ''}); erreichter CC-Stand laut Wocheneintrag: ${totals[k] ?? 'kein Eintrag'}.`);
  }
  for (const a of actuals) lines.push(`Monatsabschluss ${String(a.month).slice(0, 7)}: Eigenverbrauch ${a.eigen_cc ?? '–'}, Global gesamt ${a.global_cc ?? '–'}, 4CC-Partnerinnen ${a.four_cc_count ?? '–'}.`);
  lines.push(`Wocheneinträge (${weeks.length}):`);
  for (const w of weeks) {
    lines.push(`- Woche ab ${w.week_start}: CC-Stand ${w.cc_stand ?? '–'}, Kontakte ${w.kontakte_gesamt ?? '–'}, Präsentationen ${w.geschaeftspraesentationen_versendet ?? '–'}, nachgefasst ${w.nachgefasst ?? '–'}, Calls Mo ${w.call_montag ? 'ja' : 'nein'}/Di ${w.call_dienstag ? 'ja' : 'nein'}. Energie gekostet: ${cut(w.reflexion_1, 200) || '–'}. Gut lief: ${cut(w.reflexion_2, 200) || '–'}. Wünscht Unterstützung: ${cut(w.reflexion_3, 200) || '–'}.`);
  }
  lines.push(`Tagesabschlüsse (${days.length} in ${WEEKS_BACK} Wochen):`);
  for (const d of days.slice(-20)) {
    lines.push(`- ${d.entry_date}: ${d.kontakte_heute ?? '–'} Kontakte, ${d.verkaeufe_heute ?? '–'} CC, Stimmung ${d.stimmung ?? '–'}/5. Gut: ${cut(d.gut, 120) || '–'}. Schwer: ${cut(d.schwer, 120) || '–'}. Morgen: ${cut(d.morgen, 100) || '–'}.`);
  }
  if (chal.length) {
    lines.push('Leadership-Challenge:');
    for (const c of chal) lines.push(`- Woche ${c.week_no}: Aufgabe ${c.task_done ? 'erledigt' : 'offen'}${c.answer ? `, Antwort: ${cut(c.answer, 250)}` : ''}`);
  }
  if (notes.length) {
    lines.push('Dominiks eigene Notizen (vertraulich, NIE in fuer_leaderin oder chat_hinweise übernehmen):');
    for (const n of notes) lines.push(`- ${String(n.created_at).slice(0, 10)}: ${cut(n.note, 300)}`);
  }
  const previous = prev[0] ? { seit: String(prev[0].created_at).slice(0, 10), profil: prev[0].data } : null;
  return { text: lines.join('\n'), previous, hasData: days.length + weeks.length + chal.length > 0 };
}

// Erstellt und speichert ein neues Profil. client = makeClient() aus _lib/agent
async function updateProfile(client, leader, todayStr) {
  const input = await gatherInput(leader, todayStr);
  const prompt = `Dein letztes Profil von ${leader.name}:\n${input.previous ? JSON.stringify(input.previous) : 'Noch keins, das ist das erste Profil.'}\n\nNeue Daten:\n${input.text}\n\nSchreib das aktualisierte Profil.`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PROFILE_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Keine Antwort');
  const data = JSON.parse(block.text);
  await pgrest('leader_profiles', { method: 'POST', body: [{ leader_id: leader.id, data }] });
  return data;
}

async function latestProfiles(leaderIds) {
  if (!leaderIds.length) return {};
  const rows = await pgrest('leader_profiles', { query: `leader_id=in.(${leaderIds.join(',')})&order=created_at.desc&select=leader_id,data,created_at&limit=${leaderIds.length * 3}` });
  const out = {};
  for (const r of rows || []) if (!out[r.leader_id]) out[r.leader_id] = { ...r.data, stand: String(r.created_at).slice(0, 10) };
  return out;
}

module.exports = { PROFILE_SCHEMA, gatherInput, updateProfile, latestProfiles };
