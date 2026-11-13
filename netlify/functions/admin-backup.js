// netlify/functions/admin-backup.js
//
// GET /.netlify/functions/admin-backup?key=<ADMIN_SECRET_KEY>
//
// Datensicherung für Dominik: alle Dashboard-Tabellen als eine JSON-Datei
// zum Herunterladen. Das kostenlose Supabase bietet keine automatische
// Sicherung an. Nicht enthalten sind die Bibliothek (agent_books, lässt sich
// aus den PDFs und Videos neu laden) und die FLP-Exporte (neu hochladbar),
// weil die Datei sonst zu groß für eine Funktionsantwort wird (Limit 6 MB).
//
// Achtung: Die Datei enthält die persönlichen Links (Tokens) der Leaderinnen
// und Reflexionen. Sicher aufbewahren, nicht weitergeben.

const { pgrest } = require('./_lib/supabase');
const { requireAdmin } = require('./_lib/auth');

const TABLES = [
  'leaders', 'weekly_entries', 'daily_reflections', 'monthly_plans', 'monthly_strategy',
  'new_tps', 'intake_survey', 'ai_insights', 'push_subscriptions',
  'dashboard_visits', 'agent_memory', 'agent_messages',
];

async function fetchAll(table) {
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 50000; offset += PAGE) {
    let batch;
    try {
      batch = await pgrest(table, { query: `select=*&order=id.asc&limit=${PAGE}&offset=${offset}` });
    } catch (e) {
      // Tabelle ohne Spalte "id": ohne feste Sortierung laden (nur eine Seite sicher)
      batch = await pgrest(table, { query: `select=*&limit=${PAGE}&offset=${offset}` });
    }
    rows.push(...(batch || []));
    if (!batch || batch.length < PAGE) break;
  }
  return rows;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const key = event.queryStringParameters && event.queryStringParameters.key;
  const adminCheck = requireAdmin(event, null);
  if (!adminCheck.ok) return adminCheck.response;

  const backup = { erstellt: new Date().toISOString(), tabellen: {}, fehler: {} };
  for (const table of TABLES) {
    try {
      backup.tabellen[table] = await fetchAll(table);
    } catch (err) {
      backup.fehler[table] = err.message; // z. B. Tabelle existiert noch nicht
    }
  }

  const body = JSON.stringify(backup);
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="dashboard-sicherung-${stamp}.json"`,
      'Cache-Control': 'no-store',
    },
    body,
  };
};
