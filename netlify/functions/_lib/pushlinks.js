// netlify/functions/_lib/pushlinks.js
//
// Ziel-Link für Push-Nachrichten. Wer schon ein Passwort hat, ist per Cookie
// angemeldet: der Link enthält dann KEIN Geheimnis mehr. Nur wer noch mit dem
// alten persönlichen Link arbeitet, bekommt ihn weiter angehängt, sonst würde
// der Push auf der Anmeldeseite landen.
//
// leader: { token, password_set_at }

function dashboardUrl(leader, tab, mode) {
  const params = new URLSearchParams();
  if (leader && leader.token && !leader.password_set_at && !String(leader.token).startsWith('used-')) {
    params.set('id', leader.token);
  }
  if (tab) params.set('tab', tab);
  if (mode) params.set('mode', mode);
  const qs = params.toString();
  return '/leader-dashboard.html' + (qs ? '?' + qs : '');
}

module.exports = { dashboardUrl };
