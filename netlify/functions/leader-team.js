// netlify/functions/leader-team.js
//
// "Mein Team" der angemeldeten Leaderin. Jede sieht und ändert nur ihre
// eigenen Partnerinnen (Prüfung über _lib/auth.js und leader_id).
//
// GET                                                   -> Team, CC der letzten Monate, Fortschritt
// POST { action:"add", name, sponsor_id, rank }           -> Partnerin anlegen
// POST { action:"update", id, name?, sponsor_id?, rank?, active? }
// POST { action:"save-cc", month:"2026-11", entries:[{ id, cc }] }   (cc leer = löschen)
// POST { action:"start-onboarding", id }                 -> Einarbeitungs-Checkliste für diese Partnerin
// POST { action:"tp-step", id, step:"step_3", value }    -> Schritt der Checkliste abhaken
// POST { action:"add-note", id, note } / { action:"delete-note", note_id }      -> Coaching-Notizen
// POST { action:"save-goal", id, goal_id?, goal, target_rank?, target_date?, next_step?, status? }
// POST { action:"delete-goal", goal_id }
// "update" nimmt zusätzlich start_date und warum (Teamprofil).
//
// Bei "add" startet { onboarding:true } gleich die Checkliste (Tabelle new_tps,
// die auch JARVIS und die Kontakt-Quote lesen).

const { pgrest } = require('./_lib/supabase');
const { requireLeader, json } = require('./_lib/auth');
const { STEP_KEYS, MEMBER_RANKS, loadTeams } = require('./_lib/team');
const { memberSignals } = require('./_lib/signals');
const { monthsBack, viennaTodayStr } = require('./_lib/ranks');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cleanText = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function cleanName(n) {
  const s = String(n || '').trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= 80 ? s : null;
}

async function ownMembers(leaderId) {
  return (await pgrest('team_members', { query: `leader_id=eq.${leaderId}&select=id,sponsor_id,name` })) || [];
}

async function startOnboarding(leaderId, member) {
  const existing = await pgrest('new_tps', { query: `member_id=eq.${member.id}&select=id` });
  if (existing && existing.length) return;
  await pgrest('new_tps', { method: 'POST', body: [{ leader_id: leaderId, tp_name: member.name, member_id: member.id }] });
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
      const t = await loadTeams([leaderId], viennaTodayStr(), { coaching: true });
      const today = viennaTodayStr();
      for (const m of t.byLeader[leaderId].members) m.signals = memberSignals(m, t.ccMonth, today);
      // Ist-Eigenverbrauch (supabase/rankings.sql); fehlt die Tabelle, ohne
      const eigen = {}, globalCc = {};
      try {
        // select=* : global_cc ist eine spätere Spalte und darf noch fehlen
        const rows = await pgrest('monthly_actuals', { query: `leader_id=eq.${leaderId}&month=gte.${t.months[0]}-01&select=*` });
        for (const r of rows || []) {
          const k = String(r.month).slice(0, 7);
          if (r.eigen_cc != null) eigen[k] = Number(r.eigen_cc);
          if (r.global_cc != null) globalCc[k] = Number(r.global_cc);
        }
      } catch (e) { /* noch nicht eingerichtet */ }
      return json(200, { ccMonth: t.ccMonth, months: t.months, ranks: MEMBER_RANKS, eigen, globalCc, coachingReady: t.coachingReady, ...t.byLeader[leaderId] });
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
      const created = await pgrest('team_members', {
        method: 'POST',
        prefer: 'return=representation',
        body: [{ leader_id: leaderId, name, sponsor_id: sponsorId, rank }],
      });
      if (p.onboarding && created && created[0]) await startOnboarding(leaderId, created[0]);
      return json(200, { ok: true, id: created && created[0] ? created[0].id : null });
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
      if (p.start_date !== undefined) {
        if (p.start_date && !DATE.test(p.start_date)) return json(400, { error: 'Ungültiges Startdatum' });
        patch.start_date = p.start_date || null;
      }
      if (p.warum !== undefined) patch.warum = cleanText(p.warum, 1000);
      if (p.sponsor_id !== undefined) {
        if (!sponsorOk(members, p.id, sponsorId)) return json(400, { error: 'Diese Sponsorin geht nicht (gehört nicht zu deinem Team oder wäre im Kreis).' });
        patch.sponsor_id = sponsorId;
      }
      await pgrest('team_members', { method: 'PATCH', query: `id=eq.${p.id}&leader_id=eq.${leaderId}`, body: patch });
      if (patch.name) {
        // Name auch in der Checkliste nachziehen (JARVIS liest ihn dort)
        try {
          await pgrest('new_tps', { method: 'PATCH', query: `member_id=eq.${p.id}&leader_id=eq.${leaderId}`, body: { tp_name: patch.name } });
        } catch (e) { /* Checkliste noch nicht verknüpft */ }
      }
      return json(200, { ok: true });
    }

    if (p.action === 'start-onboarding' || p.action === 'tp-step') {
      if (!p.id || !UUID.test(p.id)) return json(400, { error: 'id fehlt' });
      const member = (await ownMembers(leaderId)).find((m) => m.id === p.id);
      if (!member) return json(404, { error: 'Nicht gefunden' });
      if (p.action === 'start-onboarding') {
        await startOnboarding(leaderId, member);
        return json(200, { ok: true });
      }
      if (!STEP_KEYS.includes(p.step)) return json(400, { error: 'Ungültiger Schritt' });
      const q = `member_id=eq.${p.id}&leader_id=eq.${leaderId}`;
      try {
        await pgrest('new_tps', { method: 'PATCH', query: q, body: { [p.step]: !!p.value, steps_updated_at: new Date().toISOString() } });
      } catch (e) {
        if (!(e.data && e.data.code === 'PGRST204')) throw e; // Spalte aus phase3.sql fehlt noch
        await pgrest('new_tps', { method: 'PATCH', query: q, body: { [p.step]: !!p.value } });
      }
      return json(200, { ok: true });
    }

    if (p.action === 'add-note' || p.action === 'save-goal') {
      if (!p.id || !UUID.test(p.id)) return json(400, { error: 'id fehlt' });
      if (!(await ownMembers(leaderId)).some((m) => m.id === p.id)) return json(404, { error: 'Nicht gefunden' });
      if (p.action === 'add-note') {
        const note = cleanText(p.note, 4000);
        if (!note) return json(400, { error: 'Bitte etwas notieren.' });
        await pgrest('coaching_notes', { method: 'POST', body: [{ author: 'leader', leader_id: leaderId, member_id: p.id, note }] });
        return json(200, { ok: true });
      }
      const goal = cleanText(p.goal, 300);
      if (!goal) return json(400, { error: 'Bitte ein Ziel eingeben.' });
      if (p.target_rank && !MEMBER_RANKS.includes(p.target_rank)) return json(400, { error: 'Ungültiger Rang' });
      if (p.target_date && !DATE.test(p.target_date)) return json(400, { error: 'Ungültiges Datum' });
      if (p.status && !['open', 'reached'].includes(p.status)) return json(400, { error: 'Ungültiger Status' });
      const row = {
        goal, target_rank: p.target_rank || null, target_date: p.target_date || null,
        next_step: cleanText(p.next_step, 500), status: p.status || 'open', updated_at: new Date().toISOString(),
      };
      if (p.goal_id) {
        if (!/^\d+$/.test(String(p.goal_id))) return json(400, { error: 'Ungültiges Ziel' });
        await pgrest('member_goals', { method: 'PATCH', query: `id=eq.${p.goal_id}&leader_id=eq.${leaderId}&member_id=eq.${p.id}`, body: row });
      } else {
        await pgrest('member_goals', { method: 'POST', body: [{ leader_id: leaderId, member_id: p.id, ...row }] });
      }
      return json(200, { ok: true });
    }

    if (p.action === 'delete-note' || p.action === 'delete-goal') {
      const id = String(p.note_id || p.goal_id || '');
      if (!/^\d+$/.test(id)) return json(400, { error: 'id fehlt' });
      // leader_id im Filter: fremde Einträge werden nie getroffen
      if (p.action === 'delete-note') {
        await pgrest('coaching_notes', { method: 'DELETE', query: `id=eq.${id}&leader_id=eq.${leaderId}&author=eq.leader` });
      } else {
        await pgrest('member_goals', { method: 'DELETE', query: `id=eq.${id}&leader_id=eq.${leaderId}` });
      }
      return json(200, { ok: true });
    }

    if (p.action === 'save-cc') {
      // erlaubt: die letzten 3 Monate bis zum aktuellen Eintrage-Monat (für Korrekturen)
      const today = viennaTodayStr();
      const allowed = monthsBack(today, 3);
      if (!allowed.includes(p.month)) return json(400, { error: 'Dieser Monat kann nicht mehr geändert werden.' });
      if (!Array.isArray(p.entries) || p.entries.length > 500) return json(400, { error: 'Keine Einträge' });
      // Eigene Monatszahlen der Leaderin (optional, leer = löschen):
      // tatsächlicher Eigenverbrauch und Global gesamt CC
      const parseOwn = (v, label) => {
        if (v === undefined) return { value: undefined };
        const raw = v === null ? '' : String(v).trim().replace(',', '.');
        if (raw === '') return { value: null };
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > 10000000) return { error: `Ungültige Zahl bei ${label}` };
        return { value: Math.round(n * 1000) / 1000 };
      };
      const eigenP = parseOwn(p.eigen_cc, 'Eigenverbrauch');
      if (eigenP.error) return json(400, { error: eigenP.error });
      const globalP = parseOwn(p.global_cc, 'Global gesamt CC');
      if (globalP.error) return json(400, { error: globalP.error });
      const eigen = eigenP.value, globalCc = globalP.value;
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
      if (eigen !== undefined || globalCc !== undefined) {
        const row = { leader_id: leaderId, month: p.month + '-01', updated_at: new Date().toISOString() };
        if (eigen !== undefined) row.eigen_cc = eigen;
        if (globalCc !== undefined) row.global_cc = globalCc;
        try {
          await pgrest('monthly_actuals', {
            method: 'POST',
            query: 'on_conflict=leader_id,month',
            prefer: 'resolution=merge-duplicates',
            body: [row],
          });
        } catch (e) {
          console.error('monthly_actuals', e.message);
          if (eigen != null || globalCc != null) return json(500, { error: 'Team-CC gespeichert, Eigenverbrauch und Global gesamt CC konnten noch nicht gespeichert werden.' });
        }
      }
      return json(200, { ok: true, saved: upserts.length });
    }

    return json(400, { error: 'Unbekannte Aktion' });
  } catch (err) {
    console.error('leader-team', err.message, err.data || '');
    return json(500, { error: 'Speichern gerade nicht möglich.' });
  }
};
