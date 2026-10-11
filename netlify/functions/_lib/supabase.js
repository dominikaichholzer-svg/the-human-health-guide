// netlify/functions/_lib/supabase.js
//
// Dünner fetch-Wrapper um Supabases REST-API (PostgREST), ohne npm-Paket,
// passend zum Rest des Projekts (keine Dependencies, kein Build-Schritt).
// Nutzt immer den service_role-Key, der auf Server-Seite bleibt und RLS
// umgeht. Dieser Key darf NIE an den Browser ausgeliefert werden.

function pgrestUrl(table, query) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL fehlt');
  const qs = query ? '?' + query : '';
  return `${base}/rest/v1/${table}${qs}`;
}

function pgrestHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY fehlt');
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

// pgrest('weekly_entries', { method: 'GET', query: 'leader_id=eq.123&order=week_start.desc' })
// pgrest('weekly_entries', { method: 'POST', query: 'on_conflict=leader_id,week_start', body: [...], prefer: 'resolution=merge-duplicates,return=representation' })
async function pgrest(table, opts = {}) {
  const { method = 'GET', query, body, prefer } = opts;
  const headers = pgrestHeaders(prefer ? { Prefer: prefer } : undefined);
  const res = await fetch(pgrestUrl(table, query), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${table} fehlgeschlagen: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

module.exports = { pgrest };
