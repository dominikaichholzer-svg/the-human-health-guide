// netlify/functions/scheduled-devplans.js
//
// Täglich früh (siehe netlify.toml): stößt die Entwicklungspläne an. Die
// Hintergrund-Funktion fragt JARVIS nur, wo etwas fällig ist (neuer Vorschlag
// ab dem 25. bzw. wenn noch keiner existiert, Auswertung am Monatsende).

const { agentSecret } = require('./_lib/telegram');

exports.handler = async function () {
  await fetch(`${process.env.URL}/.netlify/functions/leader-profiles-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
    body: JSON.stringify({ mode: 'devplans' }),
  });
  return { statusCode: 200, body: JSON.stringify({ triggered: true }) };
};
