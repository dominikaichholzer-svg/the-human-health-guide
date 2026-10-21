// netlify/functions/telegram-webhook.js
//
// POST /.netlify/functions/telegram-webhook (von Telegram aufgerufen)
//
// Nimmt Nachrichten an den JARVIS-Bot entgegen. Antwortet Telegram sofort
// mit 200 und übergibt die eigentliche Arbeit an
// telegram-agent-background.js, weil der Agent länger braucht als eine
// normale Funktion laufen darf.
//
// Befehle:
//   /start  zeigt die eigene Chat-ID (zum Einrichten von TELEGRAM_CHAT_ID)
//   /neu    beginnt ein neues Gespräch (Gedächtnis bleibt erhalten)

const { saveMessage } = require('./_lib/agent');
const { sendMessage, agentSecret, isAllowedChat } = require('./_lib/telegram');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const headerSecret = event.headers['x-telegram-bot-api-secret-token'];
  if (headerSecret !== agentSecret()) {
    return { statusCode: 403, body: 'Kein Zugriff' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 200, body: 'ok' };
  }

  const msg = update.message;
  if (!msg || !msg.chat) return { statusCode: 200, body: 'ok' };
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  try {
    if (text === '/start' && !isAllowedChat(chatId)) {
      await sendMessage(chatId, `Hallo! Deine Chat-ID ist ${chatId}. Trag sie in Netlify als TELEGRAM_CHAT_ID ein, dann kann ich dir antworten.`);
      return { statusCode: 200, body: 'ok' };
    }
    if (!isAllowedChat(chatId)) return { statusCode: 200, body: 'ok' };

    if (text === '/start') {
      await sendMessage(chatId, 'JARVIS ist bereit. Frag mich z. B. "Wie läuft das Team diese Woche?" oder "Welche neuen Leads gab es?". Mit /neu startest du ein frisches Gespräch.');
      return { statusCode: 200, body: 'ok' };
    }
    if (text === '/neu') {
      await saveMessage('user', '/neu', { kind: 'reset', telegram_update_id: update.update_id });
      await sendMessage(chatId, 'Neues Gespräch gestartet. Was ich mir gemerkt habe, weiß ich natürlich noch.');
      return { statusCode: 200, body: 'ok' };
    }
    if (!text) {
      await sendMessage(chatId, 'Ich kann im Moment nur Text lesen. Sprachnachrichten und Bilder kommen später.');
      return { statusCode: 200, body: 'ok' };
    }

    // Telegram schickt ein Update erneut, wenn es keine Antwort bekommt.
    // Über die eindeutige update_id wird jede Nachricht nur einmal bearbeitet.
    const saved = await saveMessage('user', text, { telegram_update_id: update.update_id });
    if (!saved) return { statusCode: 200, body: 'ok' };

    await fetch(`${process.env.URL}/.netlify/functions/telegram-agent-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-agent-secret': agentSecret() },
      body: JSON.stringify({ mode: 'chat', chatId }),
    });
  } catch (err) {
    console.error('telegram-webhook', err);
  }
  return { statusCode: 200, body: 'ok' };
};
