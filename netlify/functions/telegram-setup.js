// netlify/functions/telegram-setup.js
//
// GET /.netlify/functions/telegram-setup?key=<ADMIN_SECRET_KEY>
//
// Einmal im Browser aufrufen, nachdem TELEGRAM_BOT_TOKEN in Netlify
// hinterlegt ist: meldet den Webhook bei Telegram an und zeigt den
// aktuellen Stand.

const { tg, agentSecret } = require('./_lib/telegram');

exports.handler = async function (event) {
  const key = event.queryStringParameters && event.queryStringParameters.key;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return { statusCode: 403, body: 'Kein Zugriff' };
  }
  try {
    await tg('setWebhook', {
      url: `${process.env.URL}/.netlify/functions/telegram-webhook`,
      secret_token: agentSecret(),
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    await tg('setMyCommands', {
      commands: [{ command: 'neu', description: 'Neues Gespräch starten' }],
    });
    const me = await tg('getMe', {});
    const info = await tg('getWebhookInfo', {});
    const lines = [
      `Webhook eingerichtet für @${me.username}.`,
      `Webhook-URL: ${info.url}`,
      process.env.TELEGRAM_CHAT_ID
        ? `TELEGRAM_CHAT_ID ist gesetzt. Schreib dem Bot jetzt eine Nachricht.`
        : `TELEGRAM_CHAT_ID fehlt noch: schick dem Bot /start, er antwortet mit deiner Chat-ID.`,
    ];
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: lines.join('\n') };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: `Fehler: ${err.message}` };
  }
};
