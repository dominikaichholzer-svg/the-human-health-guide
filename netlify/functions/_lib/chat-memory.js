// netlify/functions/_lib/chat-memory.js
//
// Gedächtnis für den Leader-Chat: JARVIS bekommt die letzten Gespräche
// (chat_jobs, letzte 30 Tage) gekürzt in den Kontext, damit er daran
// anknüpfen kann. Die Leaderin kann ihr Gedächtnis im Chat löschen.

const { pgrest } = require('./supabase');

const DAYS = 30;
const MAX_ITEMS = 8;
const cut = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + ' …' : s; };

// Erledigte Chat-Fragen (ohne Coaching-Schwerpunkt-Aufträge), neueste zuerst
async function recentChats(leaderId, days, limit) {
  const since = new Date(Date.now() - (days || DAYS) * 86400000).toISOString();
  const rows = await pgrest('chat_jobs', {
    query: `leader_id=eq.${leaderId}&status=eq.done&created_at=gte.${since}&order=created_at.desc&limit=${limit || 30}&select=id,request,shown_message,reply,created_at`,
  });
  return (rows || []).filter((r) => !(r.request && r.request.type === 'focus') && r.shown_message && r.reply);
}

// Text für den System-Prompt. history = Nachrichten der laufenden Sitzung,
// excludeId = der Auftrag, der gerade beantwortet wird.
async function memoryText(leaderId, history, excludeId) {
  let rows = [];
  try { rows = await recentChats(leaderId); } catch (e) { return ''; }
  const inSession = new Set((Array.isArray(history) ? history : []).filter((m) => m && m.role === 'user').map((m) => String(m.content)));
  const items = rows.filter((r) => r.id !== excludeId && !inSession.has(String(r.shown_message))).slice(0, MAX_ITEMS);
  if (!items.length) return '';
  const fmt = (d) => { const s = String(d).slice(0, 10).split('-'); return `${s[2]}.${s[1]}.`; };
  return `\n\nDein Gedächtnis: frühere Gespräche mit ihr (letzte ${DAYS} Tage, neueste zuerst, gekürzt):\n`
    + items.map((r) => `- ${fmt(r.created_at)} Sie: „${cut(r.shown_message, 300)}“ → Du: „${cut(r.reply, 400)}“`).join('\n')
    + `\nNutze das wie ein guter Coach: Knüpf an, wenn es natürlich passt (z. B. kurz nachfragen, wie etwas gelaufen ist, oder auf einen früheren Tipp aufbauen), aber nicht in jeder Antwort. Wiederhol keinen Rat, ohne darauf Bezug zu nehmen. Erfinde keine Gespräche, die hier nicht stehen.`;
}

// Gedächtnis löschen (nur erledigte und fehlgeschlagene Aufträge)
async function clearMemory(leaderId) {
  await pgrest('chat_jobs', { method: 'DELETE', query: `leader_id=eq.${leaderId}&status=neq.pending` });
}

module.exports = { recentChats, memoryText, clearMemory, DAYS };
