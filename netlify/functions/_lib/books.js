// netlify/functions/_lib/books.js
//
// Bücher für JARVIS. Dominik schickt dem Bot ein PDF, der Text wird einmal
// ausgelesen und in Supabase (agent_books) gespeichert, zusammen mit einer
// kurzen Zusammenfassung. JARVIS sieht im Gedächtnis nur Titel und
// Zusammenfassung; für eine konkrete Frage liest ein günstigeres Modell
// (Haiku) das ganze Buch und gibt die passenden Stellen zurück. So kostet
// nicht jede Chat-Nachricht ein ganzes Buch an Tokens.

const { pgrest } = require('./supabase');

const READER_MODEL = 'claude-haiku-5-5';
// ca. 700.000 Tokens, darüber passt ein Buch nicht mehr sicher in einen Aufruf
const MAX_CHARS = 2800000;

async function extractPdfText(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const content = text
    .map((pageText, i) => `[Seite ${i + 1}]\n${pageText.trim()}`)
    .join('\n\n');
  const realChars = text.reduce((sum, t) => sum + t.trim().length, 0);
  return { pages: totalPages, content, realChars };
}

function bookBlock(book) {
  return {
    type: 'text',
    text: `<buch titel="${book.title}">\n${book.content}\n</buch>`,
    cache_control: { type: 'ephemeral' },
  };
}

function textOf(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function summarizeBook(client, book) {
  const response = await client.messages.create({
    model: READER_MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low' },
    messages: [
      {
        role: 'user',
        content: [
          bookBlock(book),
          {
            type: 'text',
            text: 'Fass dieses Buch auf Deutsch in 3-4 Sätzen zusammen: worum es geht und welche Themen es abdeckt, sodass man später entscheiden kann, ob es für eine Frage nützlich ist. Kein Markdown. Wenn der Titel im Buch steht, beginne mit "Titel: <Titel>" in einer eigenen Zeile.',
          },
        ],
      },
    ],
  });
  return textOf(response);
}

async function askBook(client, book, frage) {
  const response = await client.messages.create({
    model: READER_MODEL,
    max_tokens: 4000,
    output_config: { effort: 'medium' },
    messages: [
      {
        role: 'user',
        content: [
          bookBlock(book),
          {
            type: 'text',
            text: `Beantworte diese Frage nur anhand des Buchs oben: ${frage}\n\nGib die wichtigsten passenden Aussagen und Methoden aus dem Buch wieder, jeweils mit Seitenzahl, in eigenen Worten statt langer Zitate. Wenn das Buch dazu nichts sagt, sag das klar. Antwort auf Deutsch, kein Markdown.`,
          },
        ],
      },
    ],
  });
  return textOf(response);
}

// Für Bücher, die Dominik nicht als PDF hat: Sonnet recherchiert die
// Kernideen im Web und schreibt eine Buch-Notiz in eigenen Worten, die wie
// ein PDF in der Bibliothek landet (filename = WEB_NOTE).
const RESEARCH_MODEL = 'claude-sonnet-5-5';
const WEB_NOTE = 'web-recherche';

async function researchBook(client, titel) {
  const messages = [
    {
      role: 'user',
      content: `Recherchiere im Web das Buch "${titel}" (Zusammenfassungen, Rezensionen, Interviews mit dem Autor). Schreib danach eine ausführliche Buch-Notiz auf Deutsch, in eigenen Worten, ohne lange Zitate: die Kernideen, die konkreten Methoden und Modelle, wichtige Beispiele, und was davon für eine Teamleiterin im Direktvertrieb/Network-Marketing besonders nützlich ist. Etwa 1500 bis 2500 Wörter, kein Markdown.

Antworte genau in diesem Format:
TITEL: <vollständiger Titel und Autor>
KURZ: <3 Sätze, worum es geht>
NOTIZ:
<die Buch-Notiz>

Wenn du das Buch nicht eindeutig findest, antworte nur mit: NICHT_GEFUNDEN: <kurzer Grund>`,
    },
  ];
  for (let round = 0; round < 5; round++) {
    const response = await client.beta.messages.create({
      model: RESEARCH_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages,
    });
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    const text = textOf(response);
    const notFound = text.match(/NICHT_GEFUNDEN:\s*(.*)/);
    if (notFound || !/NOTIZ:/.test(text)) {
      return { gefunden: false, grund: notFound ? notFound[1].trim() : 'Keine verwertbare Recherche.' };
    }
    const title = (text.match(/TITEL:\s*(.+)/) || [])[1] || titel;
    const summary = ((text.match(/KURZ:\s*([\s\S]*?)\nNOTIZ:/) || [])[1] || '').trim();
    const content = text.split(/NOTIZ:\s*/)[1].trim();
    return { gefunden: true, title: title.trim(), summary, content };
  }
  return { gefunden: false, grund: 'Recherche hat zu lange gedauert.' };
}

async function saveBook({ title, filename, pages, content, summary }) {
  const rows = await pgrest('agent_books', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{ title, filename, pages, content, summary }],
  });
  return rows[0];
}

async function listBooks() {
  return pgrest('agent_books', { query: 'order=id.asc&select=id,title,pages,filename,summary' });
}

async function getBook(id) {
  const rows = await pgrest('agent_books', { query: `id=eq.${Number(id)}&select=id,title,content` });
  return rows[0] || null;
}

async function deleteBook(id) {
  await pgrest('agent_books', { method: 'DELETE', query: `id=eq.${Number(id)}` });
}

module.exports = {
  MAX_CHARS,
  WEB_NOTE,
  researchBook,
  extractPdfText,
  summarizeBook,
  askBook,
  saveBook,
  listBooks,
  getBook,
  deleteBook,
};
