// netlify/functions/_lib/weekly-coaching.js
//
// JARVIS-Wochen-Coaching (ersetzt die schriftliche Wochenreflexion).
// Jeden Sonntagabend liest JARVIS die Tagesabschlüsse der Woche (Mo bis So,
// Wiener Zeit) und schreibt ein persönliches Coaching. Dazu bekommt er sein
// eigenes Gedächtnis zu dieser Leaderin aus den Vorwochen und schreibt es
// fort (data.gedaechtnis). So wird das Coaching mit der Zeit individueller.
//
// Speicherung: weekly_coachings, eine Zeile pro Leaderin und Woche
// (unique leader_id + week_start, verhindert doppelte Berichte).
// Erzeugt wird es
//   - automatisch Sonntagabend (leader-profiles-background.js) und
//   - als Absicherung beim Öffnen des Dashboards (ensureCoaching), falls der
//     Sonntagslauf ausgefallen ist.
// Ohne Tagesabschlüsse in der Woche entsteht kein Coaching (nichts erfinden).

const { pgrest } = require('./supabase');
const { viennaTodayStr } = require('./ranks');
const { agentSecret } = require('./telegram');

const MODEL = 'claude-sonnet-5-5';
const READY_HOUR = 18;            // Sonntag ab 18:00 Wien gilt die Woche als fertig
const STALE_MS = 10 * 60 * 1000;  // hängender Auftrag: nach 10 Minuten neu anstoßen
const cut = (t, n) => (t == null || t === '' ? null : String(t).replace(/\s+/g, ' ').trim().slice(0, n));

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  return addDays(dateStr, -(day - 1));
}
function viennaNow(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vienna', hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { hour: Number(get('hour')) % 24, isSunday: get('weekday') === 'Sun' };
}

// Welche Woche ist "die letzte fertige"? Sonntag ab 18 Uhr die laufende,
// sonst die Vorwoche.
function targetWeek(todayStr, now = new Date()) {
  const today = todayStr || viennaTodayStr();
  const v = viennaNow(now);
  const thisMonday = mondayOf(today);
  return v.isSunday && v.hour >= READY_HOUR ? thisMonday : addDays(thisMonday, -7);
}

const COACHING_SCHEMA = {
  type: 'object',
  properties: {
    das_nimmst_du_mit: { type: 'string', description: 'Ein bis zwei Sätze: das Wichtigste, das sie aus dieser Woche mitnehmen kann. Du-Form.' },
    erfolge: { type: 'array', items: { type: 'string' }, description: '1 bis 4 Erfolge und Fortschritte, auch kleine, die sie bewusster wahrnehmen sollte, und wo sie Verantwortung übernommen hat. Jeweils mit konkretem Bezug zu ihren Einträgen.' },
    entwicklung: { type: 'array', items: { type: 'string' }, description: '0 bis 3 Beobachtungen zur persönlichen Entwicklung: sichtbare Stärken, Veränderung von Einstellung, Motivation, Selbstvertrauen. Nur wenn die Einträge es hergeben.' },
    muster: { type: 'array', items: { type: 'string' }, description: '0 bis 3 Herausforderungen und Muster: Wiederkehrendes, Zusammenhänge zwischen Gefühl, Energie und Aktivität, behutsam auch Themen, die sie vielleicht selbst noch nicht sieht.' },
    impuls: { type: 'string', description: 'Persönlicher Coaching-Impuls, 3 bis 5 Sätze: Zusammenhänge erkennen, reflektieren, ein konstruktiver Denkanstoß, gern mit einer offenen Frage. Keine Zusammenfassung der Antworten.' },
    fokus: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titel: { type: 'string', description: 'Kurz und konkret, z. B. "Zwei Nachfass-Nachrichten am Dienstag"' },
          warum: { type: 'string', description: 'Ein Satz, warum das gerade zu ihr passt' },
        },
        required: ['titel', 'warum'],
        additionalProperties: false,
      },
      description: '1 bis 3 realistische Schwerpunkte für die nächste Woche, die keine zusätzliche Arbeit erzeugen, sondern ihre Woche leichter oder klarer machen.',
    },
    gedaechtnis: {
      type: 'object',
      description: 'Dein Langzeit-Gedächtnis zu ihr. Wird nächste Woche wieder gelesen und fortgeschrieben. Nur Belegtes, kurz.',
      properties: {
        staerken: { type: 'array', items: { type: 'string' } },
        wiederkehrende_herausforderungen: { type: 'array', items: { type: 'string' } },
        motivation_verlauf: { type: 'string', description: 'Wie sich Gefühl und Motivation über die Wochen entwickeln' },
        hilfreiche_unterstuetzung: { type: 'string', description: 'Welche Art von Impuls oder Unterstützung ihr erkennbar hilft' },
        ziele: { type: 'array', items: { type: 'string' }, description: 'Ziele, die sie selbst genannt hat' },
        fortschritte: { type: 'array', items: { type: 'string' } },
        stagnation: { type: 'array', items: { type: 'string' }, description: 'Wo es seit Wochen nicht weitergeht' },
      },
      required: ['staerken', 'wiederkehrende_herausforderungen', 'motivation_verlauf', 'hilfreiche_unterstuetzung', 'ziele', 'fortschritte', 'stagnation'],
      additionalProperties: false,
    },
    datenlage: { type: 'string', enum: ['gut', 'duenn'] },
  },
  required: ['das_nimmst_du_mit', 'erfolge', 'entwicklung', 'muster', 'impuls', 'fokus', 'gedaechtnis', 'datenlage'],
  additionalProperties: false,
};

const SYSTEM = `Du bist JARVIS, persönlicher Mentor der Leaderinnen in Dominiks Forever-Living-Team. Jeden Sonntag schreibst du einer Leaderin ihr Wochen-Coaching aus ihren Tagesabschlüssen.

Haltung: empathisch, ehrlich, motivierend und konstruktiv, wie ein Mentor, der sie und ihren Weg kennt. Keine künstliche Motivation, keine Floskeln, keine Vorwürfe, keine Bewertung ihrer Person.

Regeln:
- Stütze dich nur auf das, was in den Einträgen steht. Erfinde keine Erlebnisse, Zahlen oder Gefühle. Fehlende Tage sind normal und kein Thema für Kritik. Sind es nur wenige Einträge, sag das freundlich, halte das Coaching kürzer und setze datenlage auf "duenn".
- Fasse nicht einfach zusammen. Erkenne Zusammenhänge (z. B. Gefühl und Aktivität, was sie bremst und was sie trägt) und gib einen Denkanstoß.
- Nutze dein Gedächtnis aus den Vorwochen: erkenne Entwicklung, benenne Fortschritt, und wiederhole keine allgemeinen Ratschläge. Wenn du einen früheren Fokus fortführst, sag das bewusst.
- Fokus für die nächste Woche: höchstens drei, konkret, machbar, passend zu ihrer Situation. Keine zusätzlichen Pflichten, eher etwas weglassen, bündeln oder anders angehen.
- Keine psychologischen Diagnosen, keine Heil- oder Einkommensversprechen. Entscheidungen trifft immer sie selbst.
- Das Gedächtnis schreibst du für dich: übernimm, was sich bestätigt, ergänze Neues, streiche Widerlegtes.
- Deutsch, Du-Form, warm und klar, keine Bindestriche als Satzverbinder.`;

// Material für eine Woche
async function gatherWeek(leader, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const safe = async (p) => { try { return (await p) || []; } catch (e) { return []; } };
  const [days, weeks, prev, profile] = await Promise.all([
    safe(pgrest('daily_reflections', { query: `leader_id=eq.${leader.id}&entry_date=gte.${weekStart}&entry_date=lte.${weekEnd}&order=entry_date.asc&select=*` })),
    safe(pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&week_start=eq.${weekStart}&select=*` })),
    safe(pgrest('weekly_coachings', { query: `leader_id=eq.${leader.id}&status=eq.done&week_start=lt.${weekStart}&order=week_start.desc&limit=4&select=week_start,data` })),
    safe(pgrest('leader_profiles', { query: `leader_id=eq.${leader.id}&order=created_at.desc&limit=1&select=data` })),
  ]);
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const lines = [];
  lines.push(`Leaderin: ${leader.name}, Rang ${leader.current_rank}. Woche: ${weekStart} bis ${weekEnd}. Tagesabschlüsse in dieser Woche: ${days.length} von 6 möglichen (Mo bis Sa).`);
  for (const d of days) {
    const wd = WD[new Date(d.entry_date + 'T00:00:00Z').getUTCDay()];
    const feel = d.gefuehl != null ? `${d.gefuehl}/10` : d.stimmung != null ? `${d.stimmung}/5 (alte Skala)` : '–';
    const nums = [d.kontakte_heute != null && `${d.kontakte_heute} Kontakte`, d.gespraeche_heute != null && `${d.gespraeche_heute} Gespräche`, d.neue_kunden_heute != null && `${d.neue_kunden_heute} neue Kundinnen`, d.verkaeufe_heute != null && `${d.verkaeufe_heute} CC`].filter(Boolean).join(', ');
    lines.push(`- ${wd} ${d.entry_date}: Gefühl ${feel}${nums ? `; Zahlen: ${nums}` : ''}.`
      + `${d.bewegt ? ` Bewegt: "${cut(d.bewegt, 500)}".` : ''}`
      + `${d.gut ? ` Schönster Erfolg: "${cut(d.gut, 500)}".` : ''}`
      + `${d.schwer ? ` Schwergefallen: "${cut(d.schwer, 500)}".` : ''}`
      + `${d.morgen ? ` Plan für morgen: "${cut(d.morgen, 200)}".` : ''}`
      + `${d.jarvis_frage && d.frage_antwort ? ` Auf deine Rückfrage "${cut(d.jarvis_frage, 200)}" antwortete sie: "${cut(d.frage_antwort, 400)}".` : ''}`);
  }
  const w = weeks[0];
  if (w) {
    lines.push(`Wochenzahlen: CC-Stand im Monat ${w.cc_stand ?? '–'}, Kontakte ${w.kontakte_gesamt ?? '–'}, Präsentationen ${w.geschaeftspraesentationen_versendet ?? '–'}, nachgefasst ${w.nachgefasst ?? '–'}, Calls Mo ${w.call_montag ? 'ja' : 'nein'} / Di ${w.call_dienstag ? 'ja' : 'nein'}.`);
  }
  const p = profile[0] && profile[0].data;
  if (p && p.fuer_leaderin) {
    lines.push(`Aus ihrem Entwicklungsprofil: Stärken ${(p.fuer_leaderin.staerken || []).join('; ')}. Nächster Wachstumsschritt: ${p.fuer_leaderin.naechster_schritt || '–'}.${p.chat_hinweise ? ` So unterstützt du sie am besten: ${p.chat_hinweise}` : ''}`);
  }
  const memory = prev[0] && prev[0].data && prev[0].data.gedaechtnis;
  const earlier = prev.map((c) => `- Woche ab ${c.week_start}: "${cut(c.data && c.data.das_nimmst_du_mit, 250)}" Fokus damals: ${((c.data && c.data.fokus) || []).map((f) => f.titel).join('; ') || '–'}`);
  return { text: lines.join('\n'), memory: memory || null, earlier, daysCount: days.length };
}

// Coaching für eine Woche schreiben und speichern. Gibt data oder null zurück.
async function generateCoaching(client, leader, weekStart) {
  const g = await gatherWeek(leader, weekStart);
  if (!g.daysCount) {
    // Ohne Tagesabschlüsse kein Coaching: offenen Auftrag wieder entfernen
    await pgrest('weekly_coachings', { method: 'DELETE', query: `leader_id=eq.${leader.id}&week_start=eq.${weekStart}&status=neq.done` });
    return null;
  }
  const prompt = `Dein Gedächtnis zu ${leader.name} aus den Vorwochen:\n${g.memory ? JSON.stringify(g.memory) : 'Noch keins, das ist ihr erstes Wochen-Coaching.'}\n\nDeine letzten Coachings:\n${g.earlier.length ? g.earlier.join('\n') : 'Keine.'}\n\nDiese Woche:\n${g.text}\n\nSchreib ihr Wochen-Coaching.`;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: COACHING_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Keine Antwort');
  const data = JSON.parse(block.text);
  data.fokus = (data.fokus || []).slice(0, 3);
  await pgrest('weekly_coachings', {
    method: 'PATCH',
    query: `leader_id=eq.${leader.id}&week_start=eq.${weekStart}`,
    body: { status: 'done', data, days_count: g.daysCount, finished_at: new Date().toISOString() },
  });
  return data;
}

// Auftrag anlegen. true = dieser Aufruf darf ihn bearbeiten.
async function claim(leaderId, weekStart) {
  const rows = await pgrest('weekly_coachings', {
    method: 'POST',
    query: 'on_conflict=leader_id,week_start',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: [{ leader_id: leaderId, week_start: weekStart, status: 'pending' }],
  });
  if (rows && rows.length) return true;
  // Gibt es schon: nur übernehmen, wenn fehlgeschlagen oder hängend
  const ex = await pgrest('weekly_coachings', { query: `leader_id=eq.${leaderId}&week_start=eq.${weekStart}&select=status,claimed_at` });
  const r = ex && ex[0];
  if (!r || r.status === 'done') return false;
  if (r.status === 'pending' && Date.now() - Date.parse(r.claimed_at) < STALE_MS) return false;
  const upd = await pgrest('weekly_coachings', {
    method: 'PATCH',
    prefer: 'return=representation',
    query: `leader_id=eq.${leaderId}&week_start=eq.${weekStart}&status=neq.done&claimed_at=eq.${encodeURIComponent(r.claimed_at)}`,
    body: { status: 'pending', claimed_at: new Date().toISOString() },
  });
  return !!(upd && upd.length);
}

async function hasDays(leaderId, weekStart) {
  const rows = await pgrest('daily_reflections', { query: `leader_id=eq.${leaderId}&entry_date=gte.${weekStart}&entry_date=lte.${addDays(weekStart, 6)}&select=id&limit=1` });
  return !!(rows && rows.length);
}

// Beim Öffnen des Dashboards: fehlt das Coaching der letzten fertigen Woche,
// wird es im Hintergrund angestoßen. Gibt den Stand für die Seite zurück.
async function ensureCoaching(leader, todayStr) {
  const week = targetWeek(todayStr);
  const ex = await pgrest('weekly_coachings', { query: `leader_id=eq.${leader.id}&week_start=eq.${week}&select=status,claimed_at` });
  const r = ex && ex[0];
  if (r && r.status === 'done') return { week, status: 'done' };
  if (r && r.status === 'pending' && Date.now() - Date.parse(r.claimed_at) < STALE_MS) return { week, status: 'pending' };
  if (!(await hasDays(leader.id, week))) return { week, status: 'none' };
  if (await claim(leader.id, week)) {
    try {
      await fetch(`${process.env.URL}/.netlify/functions/weekly-coaching-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
        body: JSON.stringify({ leader_id: leader.id, week_start: week }),
      });
    } catch (e) { /* nächster Aufruf versucht es wieder */ }
  }
  return { week, status: 'pending' };
}

// Coachings für die Seite (neueste zuerst), ohne das interne Gedächtnis
function publicCoaching(row) {
  const d = row.data || {};
  return {
    weekStart: row.week_start,
    daysCount: row.days_count,
    seen: !!row.seen_at,
    dasNimmstDuMit: d.das_nimmst_du_mit,
    erfolge: d.erfolge || [],
    entwicklung: d.entwicklung || [],
    muster: d.muster || [],
    impuls: d.impuls,
    fokus: d.fokus || [],
    datenlage: d.datenlage,
  };
}
async function listCoachings(leaderId, limit) {
  const rows = await pgrest('weekly_coachings', { query: `leader_id=eq.${leaderId}&status=eq.done&order=week_start.desc&limit=${limit || 12}&select=week_start,data,days_count,seen_at` });
  return (rows || []).map(publicCoaching);
}

module.exports = { targetWeek, mondayOf, addDays, gatherWeek, generateCoaching, claim, hasDays, ensureCoaching, listCoachings, publicCoaching, COACHING_SCHEMA };
