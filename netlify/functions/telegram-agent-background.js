// netlify/functions/telegram-agent-background.js
//
// Background-Funktion (Netlify lässt sie bis zu 15 Minuten laufen). Wird
// intern aufgerufen von:
//   - telegram-webhook.js        Body { mode: 'chat', chatId }
//                                     { mode: 'voice', fileId, updateId }
//                                     { mode: 'book', fileId, fileName, caption }
//                                     { mode: 'flp', fileId, fileName, caption }
//   - scheduled-agent-briefing.js Body { mode: 'briefing' }
// Lädt den Gesprächsverlauf, lässt JARVIS arbeiten und schickt die Antwort
// per Telegram an Dominik.

const { runAgent, loadHistory, saveMessage, makeClient } = require('./_lib/agent');
const books = require('./_lib/books');
const flp = require('./_lib/flp');
const { transcribe } = require('./_lib/speech');
const { sendMessage, sendTyping, downloadFile, agentSecret } = require('./_lib/telegram');

const BRIEFING_PROMPT = `[Automatisch, jeden Morgen] Erstelle mein Morgen-Briefing. Schau dir mit deinen Tools das Team und die neuen Leads der letzten 24 Stunden an. Dann schreib mir kurz:
- Wer aus dem Team heute meine Aufmerksamkeit braucht und warum (z. B. kein Eintrag seit über einer Woche, Zahlen eingebrochen, hat um Unterstützung gebeten)
- Wer gerade gut läuft und ein Lob verdient
- Neue Leads, und welche davon heute nachgefasst werden sollten
- Eine konkrete Sache, die ich heute tun sollte
- Zum Schluss ein kurzer Impuls des Tages für mich persönlich aus einem Buch deiner Bibliothek (frag dafür ein Buch mit buch_fragen). Nimm jeden Tag ein anderes Buch als in den letzten Briefings und verbinde den Gedanken mit dem, was du über meine Ziele und meine aktuelle Situation weißt. 2-3 Sätze, mit Buchtitel.
Wenn es im Team nichts Auffälliges gibt, sag das ehrlich in zwei Sätzen, der Impuls kommt trotzdem.`;

// PDF herunterladen, Text auslesen, zusammenfassen, in der Bibliothek
// speichern. Antwort landet auch im Gesprächsverlauf, damit JARVIS im
// nächsten Satz weiß, welches Buch gerade dazugekommen ist.
async function readBook({ fileId, fileName, caption }) {
  const buffer = await downloadFile(fileId);
  const { pages, content, realChars } = await books.extractPdfText(buffer);
  if (realChars < pages * 200) {
    return 'Ich konnte in diesem PDF kaum Text finden. Wahrscheinlich ist es eingescannt (nur Bilder der Seiten). Solche PDFs kann ich noch nicht lesen. Hast du eine Version mit echtem Text, z. B. aus einem E-Book?';
  }
  if (content.length > books.MAX_CHARS) {
    return `Das Buch ist mit ${pages} Seiten zu lang für mich am Stück. Kannst du es in zwei Hälften aufteilen (z. B. auf ilovepdf.com "PDF teilen") und mir beide Teile schicken?`;
  }
  const fallbackTitle = caption || (fileName || 'Buch').replace(/\.pdf$/i, '');
  const summaryRaw = await books.summarizeBook(makeClient(), { title: fallbackTitle, content });
  const titleMatch = summaryRaw.match(/^Titel:\s*(.+)$/m);
  const title = caption || (titleMatch ? titleMatch[1].trim() : fallbackTitle);
  const summary = summaryRaw.replace(/^Titel:.*$/m, '').trim();
  const book = await books.saveBook({ title, filename: fileName, pages, content, summary });
  return `📚 Gelesen und in meiner Bibliothek gespeichert: "${book.title}" (${pages} Seiten).\n\n${summary}\n\nFrag mich einfach, z. B. "Was sagt das Buch dazu, wie ich Laura motivieren kann?"`;
}

// FLP360-Excel einlesen und speichern (ohne Kontaktdaten)
async function readFlpExport({ fileId, fileName }) {
  const parsed = flp.parseExport(await downloadFile(fileId));
  await flp.saveExport(fileName, parsed);
  const s = flp.summarize(parsed);
  return `📊 FLP-Export gespeichert: ${s.partner} Partner (${s.fbo} FBO, ${s.fpc} FPC), Monate ${s.monate.join(', ')}. Telefonnummern und E-Mails habe ich weggelassen.\n\nOhne persönliches CC im ${s.monate[0]}: ${s.fbo_ohne_cc_aktueller_monat} FBO und ${s.fpc_ohne_cc_aktueller_monat} FPC.\n\nFrag mich z. B. "Liste mir alle inaktiven FBO und FPC, zuerst die, die zuletzt bestellt haben, als PDF".`;
}

exports.handler = async function (event) {
  if (event.headers['x-agent-secret'] !== agentSecret()) {
    return { statusCode: 403, body: 'Kein Zugriff' };
  }
  const payload = JSON.parse(event.body || '{}');
  const { mode } = payload;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return { statusCode: 500, body: 'TELEGRAM_CHAT_ID fehlt' };

  try {
    await sendTyping(chatId);
    if (mode === 'book') {
      const reply = await readBook(payload);
      await saveMessage('assistant', reply);
      await sendMessage(chatId, reply);
      return { statusCode: 200, body: 'ok' };
    }
    if (mode === 'flp') {
      const reply = await readFlpExport(payload);
      await saveMessage('assistant', reply);
      await sendMessage(chatId, reply);
      // Hat Dominik zur Datei gleich eine Frage geschrieben, direkt beantworten
      if (!payload.caption) return { statusCode: 200, body: 'ok' };
      await saveMessage('user', payload.caption);
    }
    if (mode === 'briefing') {
      await saveMessage('user', BRIEFING_PROMPT, { kind: 'briefing' });
    }
    if (mode === 'voice') {
      const text = await transcribe(await downloadFile(payload.fileId));
      if (!text) {
        await sendMessage(chatId, 'Ich habe in der Sprachnachricht leider nichts verstanden. Magst du es nochmal versuchen?');
        return { statusCode: 200, body: 'ok' };
      }
      // Telegram kann denselben Webhook doppelt schicken, dann nur einmal antworten
      const saved = await saveMessage('user', `[Sprachnachricht] ${text}`, { telegram_update_id: payload.updateId });
      if (!saved) return { statusCode: 200, body: 'ok' };
    }
    const history = await loadHistory();
    const reply = await runAgent(history, { deep: mode === 'briefing' });
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
