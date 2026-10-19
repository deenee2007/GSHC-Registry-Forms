/*
 * src/services/mail.js — sends email through Brevo's transactional API.
 * https://developers.brevo.com/reference/sendtransacemail
 */
const config = require('../config');

const sent = []; // messages kept by the 'memory' transport (tests)

function transport() {
  if (config.brevoApiKey && config.mailFrom) return 'brevo';
  if (config.mailTransport === 'memory' || config.mailTransport === 'console') return config.mailTransport;
  return null;
}

const enabled = () => transport() !== null;

async function send({ to, name, subject, text, html }) {
  const t = transport();
  if (!t) throw Object.assign(new Error('Email is not set up on this server.'), { status: 503 });
  const message = { to, name, subject, text, html };
  if (t === 'memory') { sent.push(message); return; }
  if (t === 'console') { console.log(`[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`); return; }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.brevoApiKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: config.mailFromName, email: config.mailFrom },
      to: [{ email: to, name: name || to }],
      subject, textContent: text, htmlContent: html
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Brevo rejected an email (${res.status}): ${detail.slice(0, 300)}`);
    throw Object.assign(new Error('The email could not be sent. Check the email settings on the server.'), { status: 502 });
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One simple, plain layout for every message. Without a link, no button.
function layout({ heading, paragraphs, button, link, footer }) {
  const text = [heading, '', ...paragraphs, '', ...(link ? [`${button}: ${link}`, ''] : []), footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#eef3ef;font-family:Segoe UI,Arial,sans-serif;color:#1d2a22">
  <div style="max-width:560px;margin:24px auto;background:#fff;border-radius:10px;padding:28px;border-top:5px solid #0b5d33">
    <div style="font-size:13px;letter-spacing:.08em;color:#5c6b62;text-transform:uppercase">Gombe State High Court of Justice</div>
    <h1 style="font-size:20px;color:#0b5d33;margin:8px 0 16px">${esc(heading)}</h1>
    ${paragraphs.map(p => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px">${esc(p)}</p>`).join('')}
    ${link ? `<p style="margin:22px 0"><a href="${esc(link)}" style="background:#0b5d33;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${esc(button)}</a></p>
    <p style="font-size:12px;color:#5c6b62;word-break:break-all">If the button does not work, copy this address into your browser:<br>${esc(link)}</p>` : ''}
    <p style="font-size:12px;color:#5c6b62;margin-top:20px">${esc(footer)}</p>
  </div></body></html>`;
  return { text, html };
}

function inviteMessage(user, link, hours) {
  return {
    subject: 'Your GSHC Registry account',
    ...layout({
      heading: 'Set up your account',
      paragraphs: [
        `Dear ${user.fullName},`,
        `An account has been created for you on the GSHC Registry Forms System. Your username is "${user.username}".`,
        `Use the button below to choose your password. The link works once and expires in ${hours} hours.`
      ],
      button: 'Choose my password', link,
      footer: 'If you were not expecting this email, you can ignore it. Directorate of ICT, Gombe State High Court of Justice.'
    })
  };
}

function resetMessage(user, link, minutes) {
  return {
    subject: 'Reset your GSHC Registry password',
    ...layout({
      heading: 'Reset your password',
      paragraphs: [
        `Dear ${user.fullName},`,
        `We received a request to reset the password for the account "${user.username}".`,
        `Use the button below to choose a new password. The link works once and expires in ${minutes} minutes.`
      ],
      button: 'Reset my password', link,
      footer: 'If you did not ask for this, ignore this email; your password stays the same. Directorate of ICT, Gombe State High Court of Justice.'
    })
  };
}

function alertMessage(user, subject, message, link) {
  return {
    subject: `GSHC Registry: ${subject}`,
    ...layout({
      heading: subject,
      paragraphs: [`Dear ${user.fullName},`, message],
      button: 'Open GSHC Registry', link,
      footer: 'You can switch these emails off under My Account. Directorate of ICT, Gombe State High Court of Justice.'
    })
  };
}

function backupFailedMessage(user, error, link) {
  return {
    subject: 'GSHC Registry: the daily backup failed',
    ...layout({
      heading: 'The daily backup failed',
      paragraphs: [`Dear ${user.fullName},`,
        `Today's automatic backup of the GSHC Registry could not be completed. The reason given was: ${error}`,
        'The system will try again every hour. You can also run a backup from the Dashboard (Back up now) once the problem is fixed. If it keeps failing, check the Cloudinary settings on Render.'],
      button: 'Open GSHC Registry', link,
      footer: 'This message goes to administrators only. Directorate of ICT, Gombe State High Court of Justice.'
    })
  };
}

module.exports = { enabled, send, inviteMessage, resetMessage, alertMessage, backupFailedMessage, sent };
