// netlify/functions/_lib/telegram.js
//
// Kleiner Wrapper um die Telegram Bot API für JARVIS. Bot-Token kommt aus
// TELEGRAM_BOT_TOKEN, erlaubt ist nur Dominiks Chat (TELEGRAM_CHAT_ID).

const crypto = require('crypto');

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN fehlt');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

// Telegram erlaubt max. 4096 Zeichen pro Nachricht, längere Antworten an
// Absätzen aufteilen
async function sendMessage(chatId, text) {
  const chunks = [];
  let rest = text;
  while (rest.length > 4000) {
    let cut = rest.lastIndexOf('\n', 4000);
    if (cut < 1000) cut = 4000;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  for (const chunk of chunks) await tg('sendMessage', { chat_id: chatId, text: chunk });
}

async function sendTyping(chatId) {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch (e) {
    // nur Kosmetik, darf nie die eigentliche Antwort verhindern
  }
}

// Geheimnis für den Webhook und den internen Aufruf der Background-Funktion,
// aus ADMIN_SECRET_KEY abgeleitet, damit keine weitere Umgebungsvariable
// nötig ist
function agentSecret() {
  const base = process.env.ADMIN_SECRET_KEY;
  if (!base) throw new Error('ADMIN_SECRET_KEY fehlt');
  return crypto.createHmac('sha256', base).update('jarvis-telegram').digest('hex');
}

function isAllowedChat(chatId) {
  return String(chatId) === String(process.env.TELEGRAM_CHAT_ID || '');
}

module.exports = { tg, sendMessage, sendTyping, agentSecret, isAllowedChat };
