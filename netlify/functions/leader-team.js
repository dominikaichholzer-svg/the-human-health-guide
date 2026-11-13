// netlify/functions/leader-team.js
//
// "Mein Team" der angemeldeten Leaderin. Jede sieht und ändert nur ihre
// eigenen Partnerinnen (Prüfung über _lib/auth.js und leader_id).
//
// GET                                                   -> Team, CC der letzten Monate, Fortschritt
// POST { action:"add", name, sponsor_id, rank }           -> Partnerin anlegen
// POST { action:"update", id, name?, sponsor_id?, rank?, active? }
// POST { action:"save-cc", month:"2026-11", entries:[{ id, cc }] }   (cc leer = löschen)

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { MEMBER_RANKS, loadTeams } = require('./_lib/team');
const { monthsBack, viennaTodayStr } = require('./_lib/ranks');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= 80 ? s : null;
}

async function ownMembers(leaderId) {
  return (await pgrest('team_members', { query: `leader_id=eq.${leaderId}&select=id,sponsor_id` })) || [];
}

// true, wenn sponsorId gültig ist (null oder eigene Partnerin) und keinen Kreis erzeugt
function sponsorOk(members, memberId, sponsorId) {
  if (sponsorId == null) return true;
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  if (!byId[sponsorId]) return false;
  let cur = sponsorId;
  for (let i = 0; i < 1000 && cur; i++) {
    if (cur === memberId) return false;
    cur = byId[cur] ? byId[cur].sponsor_id : null;
  }
  return true;
}

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Ungültiges JSON' });
    }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }

  const auth = await requireLeader(event, payload);
  if (!auth.ok) return auth.response;
  const leaderId = auth.leader.id;

  try {
    if (event.httpMethod === 'GET') {
      const t = await loadTeams([leaderId]);
      return json(200, { ccMonth: t.ccMonth, months: t.months, ranks: MEMBER_RANKS, ...t.byLeader[leaderId] });
    }

    const p = payload;
    const sponsorId = p.sponsor_id ? String(p.sponsor_id) : null;
    if (sponsorId && !UUID.test(sponsorId)) return json(400, { error: 'Ungültige Sponsorin' });

    if (p.action === 'add') {
      const name = cleanName(p.name);
      if (!name) return json(400, { error: 'Bitte einen Namen eingeben.' });
      const rank = MEMBER_RANKS.includes(p.rank) ? p.rank : 'partner';
      const members = await ownMembers(leaderId);
      if (members.length >= 500) return json(400, { error: 'Zu viele Einträge.' });
      if (!sponsorOk(members, null, sponsorId)) return json(400, { error: 'Diese Sponsorin gehört nicht zu deinem Team.' });
      await pgrest('team_members', { method: 'POST', body: [{ leader_id: leaderId, name, sponsor_id: sponsorId, rank }] });
      return json(200, { ok: true });
    }

    if (p.action === 'update') {
      if (!p.id || !UUID.test(p.id)) return json(400, { error: 'id fehlt' });
      const members = await ownMembers(leaderId);
      if (!members.some((m) => m.id === p.id)) return json(404, { error: 'Nicht gefunden' });
      const patch = { updated_at: new Date().toISOString() };
      if (p.name !== undefined) {
        const name = cleanName(p.name);
        if (!name) return json(400, { error: 'Bitte einen Namen eingeben.' });
        patch.name = name;
      }
      if (p.rank !== undefined) {
        if (!MEMBER_RANKS.includes(p.rank)) return json(400, { error: 'Ungültiger Rang' });
        patch.rank = p.rank;
      }
      if (p.active !== undefined) patch.active = !!p.active;
      if (p.sponsor_id !== undefined) {
        if (!sponsorOk(members, p.id, sponsorId)) return json(400, { error: 'Diese Sponsorin geht nicht (gehört nicht zu deinem Team oder wäre im Kreis).' });
        patch.sponsor_id = sponsorId;
      }
      await pgrest('team_members', { method: 'PATCH', query: `id=eq.${p.id}&leader_id=eq.${leaderId}`, body: patch });
      return json(200, { ok: true });
    }

    if (p.action === 'save-cc') {
      // erlaubt: die letzten 3 Monate bis zum aktuellen Eintrage-Monat (für Korrekturen)
      const today = viennaTodayStr();
      const allowed = monthsBack(today, 3);
      if (!allowed.includes(p.month)) return json(400, { error: 'Dieser Monat kann nicht mehr geändert werden.' });
      if (!Array.isArray(p.entries) || p.entries.length > 500) return json(400, { error: 'Keine Einträge' });
      const own = new Set((await ownMembers(leaderId)).map((m) => m.id));
      const upserts = [];
      const deletes = [];
      for (const e of p.entries) {
        if (!e || !own.has(e.id)) return json(400, { error: 'Eine Partnerin gehört nicht zu deinem Team.' });
        const raw = e.cc === null || e.cc === undefined ? '' : String(e.cc).trim().replace(',', '.');
        if (raw === '') { deletes.push(e.id); continue; }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > 100000) return json(400, { error: 'Ungültige CC-Zahl' });
        upserts.push({ member_id: e.id, month: p.month + '-01', cc: Math.round(v * 1000) / 1000, updated_at: new Date().toISOString() });
      }
      if (upserts.length) {
        await pgrest('team_member_cc', {
          method: 'POST',
          query: 'on_conflict=member_id,month',
          prefer: 'resolution=merge-duplicates',
          body: upserts,
        });
      }
      if (deletes.length) {
        await pgrest('team_member_cc', { method: 'DELETE', query: `member_id=in.(${deletes.join(',')})&month=eq.${p.month}-01` });
      }
      return json(200, { ok: true, saved: upserts.length });
    }

    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('leader-team', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
