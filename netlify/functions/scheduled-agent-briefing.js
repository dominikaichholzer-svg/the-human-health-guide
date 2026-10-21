// netlify/functions/scheduled-agent-briefing.js
//
// Läuft jeden Morgen (siehe netlify.toml) und stößt JARVIS' Morgen-Briefing
// an. Die eigentliche Arbeit macht telegram-agent-background.js, weil
// geplante Funktionen nur 30 Sekunden laufen dürfen.

const { agentSecret } = require('./_lib/telegram');

exports.handler = async function () {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return { statusCode: 200, body: JSON.stringify({ skipped: 'Telegram nicht eingerichtet' }) };
  }
  await fetch(`${process.env.URL}/.netlify/functions/telegram-agent-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
    body: JSON.stringify({ mode: 'briefing' }),
  });
  return { statusCode: 200, body: JSON.stringify({ triggered: true }) };
};
