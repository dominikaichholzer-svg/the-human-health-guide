// netlify/functions/_lib/pdf.js
//
// Baut aus JARVIS' Text ein schlichtes, gut lesbares A4-PDF (pdf-lib,
// eingebaute Helvetica, also keine Schriftdateien nötig).
//
// Einfaches Format im Text:
//   # Überschrift          große Überschrift (z. B. pro Person)
//   ## Zwischenüberschrift
//   - Punkt                Aufzählung
//   > Text                 hervorgehobener Kasten, z. B. eine WhatsApp-Nachricht
//   Leerzeile              neuer Absatz
// Emojis und andere Zeichen, die Helvetica nicht kennt, fallen weg.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const A4 = [595.28, 841.89];
const MARGIN = 50;
const GREEN = rgb(0.05, 0.18, 0.17);
const MUTED = rgb(0.35, 0.4, 0.39);
const BOX = rgb(0.93, 0.96, 0.95);

function viennaDate() {
  return new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());
}

async function buildPdf(title, body) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('JARVIS');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  // Zeichen entfernen, die die Standardschrift nicht darstellen kann
  const okCache = new Map();
  const clean = (text) =>
    [...String(text).replace(/\*\*/g, '').replace(/\t/g, '  ')]
      .filter((ch) => {
        if (!okCache.has(ch)) {
          try {
            regular.widthOfTextAtSize(ch, 10);
            okCache.set(ch, true);
          } catch (e) {
            okCache.set(ch, false);
          }
        }
        return okCache.get(ch);
      })
      .join('')
      .replace(/ {2,}/g, ' ')
      .trim();

  const width = A4[0] - 2 * MARGIN;
  let page;
  let y;

  function newPage() {
    page = doc.addPage(A4);
    y = A4[1] - MARGIN;
  }

  function ensure(space) {
    if (y - space < MARGIN + 20) newPage();
  }

  function wrap(text, font, size, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) <= maxWidth || !line) {
        line = test;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function write(text, { font = regular, size = 10.5, color = GREEN, indent = 0, gapAfter = 4, lineHeight = 1.4 } = {}) {
    const lines = wrap(text, font, size, width - indent);
    for (const line of lines) {
      ensure(size * lineHeight);
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color });
      y -= size * lineHeight;
    }
    y -= gapAfter;
  }

  function quoteBox(text) {
    const size = 10;
    const pad = 8;
    const lines = wrap(text, italic, size, width - 2 * pad - 6);
    const h = lines.length * size * 1.4 + 2 * pad;
    ensure(Math.min(h, 300));
    // Kasten nur zeichnen, wenn er auf die Seite passt, sonst als normaler Text
    if (y - h >= MARGIN + 20) {
      page.drawRectangle({ x: MARGIN, y: y - h, width, height: h, color: BOX });
      page.drawRectangle({ x: MARGIN, y: y - h, width: 3, height: h, color: GREEN });
      let ty = y - pad;
      for (const line of lines) {
        page.drawText(line, { x: MARGIN + pad + 6, y: ty - size, size, font: italic, color: GREEN });
        ty -= size * 1.4;
      }
      y -= h + 8;
    } else {
      write(text, { font: italic, size, indent: 10 });
    }
  }

  newPage();
  write(clean(title), { font: bold, size: 20, gapAfter: 2, lineHeight: 1.25 });
  write('JARVIS · erstellt am ' + viennaDate(), { size: 9, color: MUTED, gapAfter: 10 });
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.8, color: GREEN });
  y -= 16;

  for (const raw of String(body).split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      y -= 5;
      continue;
    }
    if (/^#\s/.test(line)) {
      y -= 8;
      ensure(60);
      write(clean(line.replace(/^#\s+/, '')), { font: bold, size: 15, gapAfter: 4, lineHeight: 1.3 });
    } else if (/^##\s/.test(line)) {
      y -= 4;
      ensure(40);
      write(clean(line.replace(/^##\s+/, '')), { font: bold, size: 12, gapAfter: 3 });
    } else if (/^\s*[-*•]\s/.test(line)) {
      const text = clean(line.replace(/^\s*[-*•]\s+/, ''));
      ensure(16);
      page.drawText('•', { x: MARGIN + 4, y: y - 10.5, size: 10.5, font: bold, color: GREEN });
      write(text, { indent: 16, gapAfter: 2 });
    } else if (/^>\s?/.test(line)) {
      quoteBox(clean(line.replace(/^>\s?/, '')));
    } else {
      write(clean(line));
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Seite ${i + 1} von ${pages.length}`, { x: A4[0] - MARGIN - 70, y: 25, size: 8, font: regular, color: MUTED });
  });

  return Buffer.from(await doc.save());
}

module.exports = { buildPdf };
