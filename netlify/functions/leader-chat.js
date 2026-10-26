// netlify/functions/leader-chat.js
//
// POST /.netlify/functions/leader-chat
// Body: { token, message, history }
//   history: [{ role: 'user'|'assistant', content: '...' }, ...] letzte paar
//            Nachrichten, nur fürs Gesprächsgedächtnis in dieser Sitzung,
//            wird nicht in der Datenbank gespeichert.
//
// Chat-Assistent "JARVIS" für die Leaderinnen: Ideen für Ansprache,
// Planung, Einwandbehandlung. Nutzt denselben ANTHROPIC_API_KEY wie das
// wöchentliche AI-Feedback.

const { pgrest } = require('./_lib/supabase');
const { PANEL_WISDOM } = require('./_lib/panel-wisdom');
const { makeClient } = require('./_lib/agent');

const SYSTEM_PROMPT = `Du bist JARVIS, ein Business-Coaching-Assistent für die Team-Leaderinnen bei einem Forever-Living-Team (Aloe-Vera-Produkte, Direktvertrieb/Network-Marketing). Die Leaderinnen chatten mit dir, wenn sie Ideen brauchen: wie sie jemanden ansprechen, ihre Woche planen, mit einem Einwand umgehen, oder einfach eine zweite Meinung wollen.

Wichtiger Kontext zum Team-System, damit deine Antworten wirklich passen:
- Grundprinzip der Ansprache: immer ein echtes, ehrliches Kompliment zuerst, nie ein kalter Pitch. Nicht "ich bin selbstständig und suche Testpersonen", sondern eher "ich lerne gerade Leute/die Gegend kennen" als Rahmen.
- Bei Produkttests/Umfragen: Kontakt sichern (Name + Nummer/Insta) ist das Wichtigste, sonst verpufft der Kontakt.
- Conversion von Kunde zu Team-Partnerin passiert meist NICHT über kalte Geschäfts-Pitches, sondern dadurch dass jemand vom Produkt begeistert ist und dann persönlich gefragt wird, ob sie die Produkte dauerhaft 30% günstiger bekommen will (als FPC/Vorzugskunde oder FBO/Geschäftspartnerin).
- November 2026 ist ein Sondermonat: Fokus auf Weihnachtsgeschenke verkaufen. Jede Leaderin hat eine persönliche Geschenke-Umfrage mit 9 Sets (Haar, Gesicht, Körper in small, medium, large), den Link findet sie im Dashboard unter Überblick.
- 3-Monats-Zyklus: Monat 1 = Verschenken (Testboxen, Kontakte sammeln), Monat 2 = Nachfassen & Verkaufen (30%-Rabatt anbieten), Monat 3 = Einladen (Open House/Business-Präsentation).
- Rangweg: Supervisor → Assistant Manager → Manager → Eagle Manager. Ziel ist Manager bis 30.04.2027, dann das Eagle-Jahr bis 30.04.2028.
- Einwände immer erst anerkennen, dann locker antworten, nie dagegenhalten.

Antworte auf Deutsch, warm aber knapp (2-5 Sätze meistens, außer explizit mehr verlangt wird), konkret und direkt umsetzbar, keine generischen Motivationsfloskeln. Wenn eine Frage nichts mit dem Geschäft zu tun hat, darfst du trotzdem freundlich helfen, aber dein Schwerpunkt ist Business-Coaching.`;

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Ungültiger Request-Body' }) };
  }

  const { token, message, history } = payload;
  if (!token || !message) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Token oder Nachricht fehlt' }) };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Chat ist aktuell nicht verfügbar.' }) };
  }

  try {
    const leaders = await pgrest('leaders', {
      query: `token=eq.${encodeURIComponent(token)}&select=id,name,current_rank`,
    });
    if (!leaders || leaders.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Nicht gefunden' }) };
    }
    const leader = leaders[0];

    const safeHistory = (Array.isArray(history) ? history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10);

    const messages = [
      ...safeHistory.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    // Das Modell denkt bei längeren Fragen zuerst nach (eigene Blöcke ohne
    // Text), darum alle Text-Blöcke zusammensetzen statt nur den ersten
    // Block zu lesen, und genug max_tokens für Denken plus Antwort lassen.
    const response = await makeClient().beta.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT + '\n\n' + PANEL_WISDOM + `\n\nDu sprichst gerade mit ${leader.name}, aktueller Rang: ${leader.current_rank}.`,
      messages,
    });
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const reply =
      response.stop_reason === 'refusal' || !text
        ? 'Dazu kann ich dir gerade leider nichts sagen. Frag mich gern etwas anderes.'
        : text;

    return { statusCode: 200, body: JSON.stringify({ reply }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Serverfehler', detail: err.message }) };
  }
};
