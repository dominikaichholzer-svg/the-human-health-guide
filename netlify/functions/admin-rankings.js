// netlify/functions/admin-rankings.js
//
// Vier getrennte Rankings, NUR für den Admin. Sie werden nie zu einer
// Gesamtpunktzahl zusammengerechnet.
//   1. Persönliche CC       (höchster CC-Stand der Wocheneinträge im Monat)
//   2. Call-Teilnahme Mo/Di (Häkchen in der Wochenreflexion, Wochen ab Montag im Monat)
//   3. Eigenverbrauch CC    (tatsächlicher Wert aus dem Monatsabschluss)
//   4. 4CC-Leaderentwicklung (Partnerinnen in "Mein Team" mit mindestens 4 CC im Monat)
//
// GET ?month=2026-11   (ohne month: Vormonat; wählbar: laufender + 3 Monate davor)

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');
const { monthsBack, monthlyTotals, viennaTodayStr } = require('./_lib/ranks');
const { nextMonthKey } = require('./_lib/pins');

const FOUR_CC = 4;

// Montage im Monat bis heute (jeder Montag = eine Call-Woche mit 2 Calls)
function mondaysIn(monthKey, today) {
  const out = [];
  const d = new Date(monthKey + '-01T00:00:00Z');
  while (d.toISOString().slice(0, 7) === monthKey) {
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 1 && iso <= today) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Sortiert absteigend, gleiche Werte = gleicher Platz, fehlende Werte ans Ende ohne Platz
function rank(rows) {
  const withVal = rows.filter((r) => r.value != null).sort((a, b) => b.value - a.value);
  let place = 0, last = null;
  withVal.forEach((r, i) => {
    if (r.value !== last) { place = i + 1; last = r.value; }
    r.place = place;
  });
  return withVal.concat(rows.filter((r) => r.value == null).map((r) => ({ ...r, place: null })));
}

// Berechnung ohne HTTP, damit auch JARVIS (Telegram) sie nutzen kann
async function computeRankings(requestedMonth) {
  const today = viennaTodayStr();
  const months = monthsBack(today, 4).reverse(); // neueste zuerst
  const month = months.includes(requestedMonth) ? requestedMonth : months[1];
  const from = month + '-01';
  const to = nextMonthKey(month) + '-01';
  const safe = async (p) => { try { return { ok: true, rows: (await p) || [] }; } catch (e) { return { ok: false, rows: [] }; } };

  {
    const leaders = (await pgrest('leaders', { query: 'select=id,name&order=sort_order.asc' })) || [];
    const mondays = mondaysIn(month, today);

    const [weeks, actuals, members] = await Promise.all([
      safe(pgrest('weekly_entries', { query: `week_start=gte.${from}&week_start=lt.${to}&select=*` })),
      safe(pgrest('monthly_actuals', { query: `month=eq.${from}&select=leader_id,eigen_cc` })),
      safe(pgrest('team_members', { query: 'select=id,leader_id,name' })),
    ]);
    let ccRows = { ok: true, rows: [] };
    if (members.rows.length) {
      ccRows = await safe(pgrest('team_member_cc', { query: `month=eq.${from}&select=member_id,cc` }));
    }
    const memberById = Object.fromEntries(members.rows.map((m) => [m.id, m]));
    const callsTracked = weeks.rows.some((w) => 'call_montag' in w);

    const personal = [], calls = [], eigen = [], fourCc = [];
    for (const l of leaders) {
      const lw = weeks.rows.filter((w) => w.leader_id === l.id);
      const totals = monthlyTotals(lw);
      personal.push({ name: l.name, value: totals[month] != null ? totals[month] : null });

      const attended = lw.filter((w) => mondays.includes(w.week_start))
        .reduce((a, w) => a + (w.call_montag ? 1 : 0) + (w.call_dienstag ? 1 : 0), 0);
      const possible = mondays.length * 2;
      calls.push({ name: l.name, value: possible && callsTracked ? Math.round((attended / possible) * 100) : null, detail: possible ? `${attended} von ${possible} Calls` : '' });

      const a = actuals.rows.find((r) => r.leader_id === l.id);
      eigen.push({ name: l.name, value: a && a.eigen_cc != null ? Number(a.eigen_cc) : null });

      const strong = ccRows.rows.filter((r) => memberById[r.member_id] && memberById[r.member_id].leader_id === l.id && Number(r.cc) >= FOUR_CC)
        .map((r) => memberById[r.member_id].name);
      const hasTeamCc = ccRows.rows.some((r) => memberById[r.member_id] && memberById[r.member_id].leader_id === l.id);
      fourCc.push({ name: l.name, value: hasTeamCc ? strong.length : null, detail: strong.join(', ') });
    }

    return {
      month,
      months,
      isCurrentMonth: month === months[0],
      rankings: [
        { key: 'personal_cc', title: 'Persönliche CC', unit: 'CC', hint: 'Höchster CC-Stand aus den Wocheneinträgen des Monats', rows: rank(personal) },
        { key: 'calls', title: 'Call-Teilnahme Montag/Dienstag', unit: '%', hint: callsTracked ? `${mondays.length} Call-Wochen im Monat, selbst abgehakt in der Wochenreflexion` : 'Noch keine Daten (Call-Häkchen gibt es ab jetzt in der Wochenreflexion)', rows: rank(calls) },
        { key: 'eigen_cc', title: 'Eigenverbrauch CC', unit: 'CC', hint: actuals.ok ? 'Tatsächlicher Wert aus dem Monatsabschluss' : 'Noch nicht eingerichtet', rows: rank(eigen) },
        { key: 'four_cc', title: '4CC-Leaderentwicklung', unit: 'Partnerinnen', hint: `Partnerinnen in "Mein Team" mit mindestens ${FOUR_CC} CC im Monat`, rows: rank(fourCc) },
      ],
    };
  }
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });
  const adminCheck = await requireAdmin(event, null);
  if (!adminCheck.ok) return adminCheck.response;
  try {
    return json(200, await computeRankings((event.queryStringParameters || {}).month));
  } catch (err) {
    console.error('admin-rankings', err.message, err.data || '');
    return json(500, { error: 'Rankings gerade nicht verfügbar.' });
  }
};

exports.computeRankings = computeRankings;
