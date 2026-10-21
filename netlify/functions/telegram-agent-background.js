// netlify/functions/telegram-agent-background.js
//
// Background-Funktion (Netlify lässt sie bis zu 15 Minuten laufen). Wird
// intern aufgerufen von:
//   - telegram-webhook.js        Body { mode: 'chat', chatId }
//   - scheduled-agent-briefing.js Body { mode: 'briefing' }
// Lädt den Gesprächsverlauf, lässt JARVIS arbeiten und schickt die Antwort
// per Telegram an Dominik.

const { runAgent, loadHistory, saveMessage } = require('./_lib/agent');
const { sendMessage, sendTyping, agentSecret } = require('./_lib/telegram');

const BRIEFING_PROMPT = `[Automatisch, jeden Morgen] Erstelle mein Morgen-Briefing. Schau dir mit deinen Tools das Team und die neuen Leads der letzten 24 Stunden an. Dann schreib mir kurz:
- Wer aus dem Team heute meine Aufmerksamkeit braucht und warum (z. B. kein Eintrag seit über einer Woche, Zahlen eingebrochen, hat um Unterstützung gebeten)
- Wer gerade gut läuft und ein Lob verdient
- Neue Leads, und welche davon heute nachgefasst werden sollten
- Eine konkrete Sache, die ich heute tun sollte
Wenn es nichts Auffälliges gibt, sag das ehrlich in zwei Sätzen.`;

exports.handler = async function (event) {
  if (event.headers['x-agent-secret'] !== agentSecret()) {
    return { statusCode: 403, body: 'Kein Zugriff' };
  }
  const { mode } = JSON.parse(event.body || '{}');
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { statusCode: 500, body: 'TELEGRAM_CHAT_ID fehlt' };

  try {
    await sendTyping(chatId);
    if (mode === 'briefing') {
      await saveMessage('user', BRIEFING_PROMPT, { kind: 'briefing' });
    }
    const history = await loadHistory();
    const reply = await runAgent(history);
    await saveMessage('assistant', reply);
    await sendMessage(chatId, reply);
  } catch (err) {
    console.error('telegram-agent-background', err);
    try {
      await sendMessage(chatId, `Da ist etwas schiefgelaufen: ${err.message}`);
    } catch (e) {
      // Telegram selbst nicht erreichbar, bleibt nur das Log
    }
  }
  return { statusCode: 200, body: 'ok' };
};
