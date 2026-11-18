// netlify/functions/admin-incentives.js
//
// Incentives verwalten (nur Admin).
// GET                         -> alle Incentives, bei sichtbaren der Stand je Leaderin
// POST { incentive }          -> anlegen (ohne id) oder ändern (mit id)
// POST { delete_id }          -> löschen

const { pgrest } = require('./_lib/supabase');
const { requireAdmin, json } = require('./_lib/auth');
const { viennaTodayStr } = require('./_lib/ranks');
const { evalIncentive, loadLeaderData } = require('./_lib/incentive');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0; };

function cleanLevels(levels) {
  if (!Array.isArray(levels)) return null;
  return levels.slice(0, 6).map((l) => ({
    name: String(l.name || '').trim().slice(0, 40) || 'Level',
    new_cc: num(l.new_cc),
    new_as: Math.round(num(l.new_as)),
    new_s: Math.round(num(l.new_s)),
    active_cc: num(l.active_cc),
    bonus: !!l.bonus,
    from: l.bonus && DATE.test(l.from || '') ? l.from : null,
    to: l.bonus && DATE.test(l.to || '') ? l.to : null,
    reward: String(l.reward || '').trim().slice(0, 600),
  }));
}

exports.handler = async function (event) {
  let payload = null;
  if (event.httpMethod === 'POST') {
    try { payload = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Ungültiges JSON' }); }
  } else if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const adminCheck = await requireAdmin(event, payload);
  if (!adminCheck.ok) return adminCheck.response;

  try {
    if (event.httpMethod === 'GET') {
      const today = viennaTodayStr();
      const incs = (await pgrest('incentives', { query: 'order=start_date.desc&select=*' })) || [];
      const leaders = (await pgrest('leaders', { query: 'select=id,name,on_hold&order=sort_order.asc' })) || [];
      const running = incs.filter((i) => i.active && String(i.start_date) <= today);
      const byLeader = {};
      if (running.length) {
        for (const l of leaders) {
          const data = await loadLeaderData(l.id);
          byLeader[l.id] = running.map((i) => evalIncentive(i, data, today));
        }
      }
      return json(200, {
        today,
        incentives: incs.map((i) => ({
          ...i,
          leaders: running.includes(i)
            ? leaders.map((l) => ({ id: l.id, name: l.name, onHold: !!l.on_hold, progress: byLeader[l.id].find((p) => p.id === i.id) }))
            : [],
        })),
      });
    }

    const p = payload;
    if (p.delete_id) {
      if (!UUID.test(p.delete_id)) return json(400, { error: 'id fehlt' });
      await pgrest('incentives', { method: 'DELETE', query: `id=eq.${p.delete_id}` });
      return json(200, { ok: true });
    }
    const i = p.incentive || {};
    const title = String(i.title || '').trim().slice(0, 80);
    if (!title) return json(400, { error: 'Titel fehlt' });
    if (!DATE.test(i.start_date || '') || !DATE.test(i.end_date || '') || i.end_date < i.start_date) {
      return json(400, { error: 'Zeitraum prüfen (Start und Ende)' });
    }
    const levels = cleanLevels(i.levels);
    if (!levels || !levels.length) return json(400, { error: 'Mindestens ein Level anlegen' });
    const row = {
      title,
      subtitle: String(i.subtitle || '').trim().slice(0, 160) || null,
      start_date: i.start_date,
      end_date: i.end_date,
      levels,
      active: i.active !== false,
      updated_at: new Date().toISOString(),
    };
    if (i.id) {
      if (!UUID.test(i.id)) return json(400, { error: 'id ungültig' });
      await pgrest('incentives', { method: 'PATCH', query: `id=eq.${i.id}`, body: row });
    } else {
      await pgrest('incentives', { method: 'POST', body: [row] });
    }
    return json(200, { ok: true });
  } catch (err) {
    console.error('admin-incentives', err.message, err.data || '');
    return json(500, { error: 'Incentives gerade nicht verfügbar. Ist supabase/incentives.sql ausgeführt?' });
  }
};
