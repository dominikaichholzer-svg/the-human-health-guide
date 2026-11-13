// netlify/functions/_lib/notify.js
//
// Empfänger für Mails an den Admin (Login-Code). Gleiche Regel wie bei der
// Strategie-Erinnerung: ADMIN_EMAIL, sonst NOTIFY_EMAIL, sonst die bisher fest
// eingetragene Adresse.

function adminEmail() {
  return process.env.ADMIN_EMAIL || process.env.NOTIFY_EMAIL || 'dominikaichholzer@gmail.com';
}

// Schickt eine Mail über Resend. Wirft bei Fehlern, damit der Aufrufer es merkt.
async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY fehlt');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: 'Team-Dashboard <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return (u ? u[0] : '') + '•••@' + (d || '');
}

module.exports = { adminEmail, sendMail, maskEmail };
