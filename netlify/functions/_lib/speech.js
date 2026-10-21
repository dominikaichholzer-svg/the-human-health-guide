// netlify/functions/_lib/speech.js
//
// Sprachnachrichten für JARVIS: wandelt Telegram-Sprachnachrichten (OGG)
// über ElevenLabs Speech-to-Text in Text um. Braucht ELEVENLABS_API_KEY.

async function transcribe(buffer, filename = 'voice.ogg') {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY fehlt, ich kann Sprachnachrichten noch nicht verstehen.');
  const form = new FormData();
  form.append('model_id', process.env.ELEVENLABS_STT_MODEL || 'scribe_v1');
  form.append('file', new Blob([buffer]), filename);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.text || '').trim();
}

module.exports = { transcribe };
