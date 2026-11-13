// netlify/functions/scheduled-leader-profiles.js
//
// Sonntagabend (siehe netlify.toml): stößt die wöchentliche Aktualisierung der
// JARVIS-Entwicklungsprofile an. Die Arbeit macht leader-profiles-background.js,
// weil geplante Funktionen nur 30 Sekunden laufen dürfen.

const { agentSecret } = require('./_lib/telegram');

exports.handler = async function () {
  await fetch(`${process.env.URL}/.netlify/functions/leader-profiles-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
    body: JSON.stringify({}),
  });
  return { statusCode: 200, body: JSON.stringify({ triggered: true }) };
};
