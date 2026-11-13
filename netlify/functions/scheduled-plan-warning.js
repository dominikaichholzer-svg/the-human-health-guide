// netlify/functions/scheduled-plan-warning.js
//
// Läuft täglich (siehe netlify.toml), wird aber nur am 10. und am 20. aktiv.
// Liegt eine Leaderin hinter ihrem Monatsplan (_lib/leader-context.js,
// planStatus), bekommt sie eine Push-Nachricht. Ein Tipp darauf öffnet den
// Chat, und JARVIS gibt ihr gleich 3 konkrete Ideen.

const { pgrest } = require('./_lib/supabase');
const { sendPush } = require('./_lib/webpush');
const { viennaTodayStr, monthlyTotals } = require('./_lib/ranks');
const { dashboardUrl } = require('./_lib/pushlinks');
const { planStatus } = require('./_lib/leader-context');

const WARN_DAYS = [10, 20];
const fmt = (n) => Number(n).toLocaleString('de-AT', { maximumFractionDigits: 3 });

exports.handler = async function () {
  const today = viennaTodayStr();
  if (!WARN_DAYS.includes(Number(today.slice(8, 10)))) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'nicht der 10. oder 20.' }) };
  }
  const monthKey = today.slice(0, 7);
  try {
    const leaders = (await pgrest('leaders', { query: 'select=*' })) || [];
    const results = [];
    for (const leader of leaders) {
      const plans = await pgrest('monthly_plans', { query: `leader_id=eq.${leader.id}&target_month=eq.${monthKey}-01&select=plan_cc` });
      if (!plans || !plans[0]) { results.push({ leader: leader.name, skipped: 'keine Planung' }); continue; }
      const weeks = await pgrest('weekly_entries', { query: `leader_id=eq.${leader.id}&week_start=gte.${monthKey}-01&select=week_start,cc_stand` });
      const st = planStatus(Number(plans[0].plan_cc), monthlyTotals(weeks || [])[monthKey], today);
      if (!st || !st.behind) { results.push({ leader: leader.name, skipped: 'im Plan' }); continue; }

      const subs = await pgrest('push_subscriptions', { query: `leader_id=eq.${leader.id}` });
      const url = dashboardUrl(leader) + (dashboardUrl(leader).includes('?') ? '&' : '?') + 'tab=chat&ask=plan';
      let sent = 0;
      for (const sub of subs || []) {
        try {
          await sendPush(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            { title: 'Dein Monatsziel braucht dich 💪', body: `Noch ${fmt(st.remaining)} CC bis zu deinem Plan, ${st.daysLeft} Tage Zeit. JARVIS hat Ideen für dich.`, url }
          );
          sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pgrest('push_subscriptions', { method: 'DELETE', query: `id=eq.${sub.id}` });
          }
        }
      }
      results.push({ leader: leader.name, behind: true, remaining: st.remaining, sent });
    }
    return { statusCode: 200, body: JSON.stringify({ today, results }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
