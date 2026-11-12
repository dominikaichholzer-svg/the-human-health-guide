// netlify/functions/_lib/pushlinks.js
//
// Der Dashboard-Link jeder Leaderin ist persönlich (?id=<token>). Ein Push,
// der nur auf "/" zeigt, würde ohne Token öffnen und eine Fehlerseite
// zeigen. Darum hängen wir das Token an den Link.

function dashboardUrl(token, tab, mode) {
  const params = new URLSearchParams({ id: token });
  if (tab) params.set('tab', tab);
  if (mode) params.set('mode', mode);
  return `/leader-dashboard.html?${params.toString()}`;
}

module.exports = { dashboardUrl };
