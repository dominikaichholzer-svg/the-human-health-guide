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

async function saveBook({ title, filename, pages, content, summary }) {
  const rows = await pgrest('agent_books', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{ title, filename, pages, content, summary }],
  });
  return rows[0];
}

async function listBooks() {
  return pgrest('agent_books', { query: 'order=id.asc&select=id,title,pages,summary' });
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
  extractPdfText,
  summarizeBook,
  askBook,
  saveBook,
  listBooks,
  getBook,
  deleteBook,
};
