const { Resend } = require('resend');
const { approvedHtml, approvedText } = require('../emails/approved');
const { deniedHtml, deniedText }     = require('../emails/denied');
const { newDropHtml, newDropText }   = require('../emails/newdrop');
const { broadcastHtml }              = require('../emails/broadcast');
const { messageHtml }                = require('../emails/message');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = `${process.env.FROM_NAME || 'Blank Labs'} <${process.env.FROM_EMAIL}>`;

async function sendApproval(email, passphrase) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'You have been approved.',
    html: approvedHtml(passphrase),
    text: approvedText(passphrase),
  });
}

async function sendDenial(email) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Your request.',
    html: deniedHtml(),
    text: deniedText(),
  });
}

async function sendDropNotification(emails, drop) {
  if (!emails.length) return;
  // Batch sends — Resend supports up to 50 recipients
  const chunks = [];
  for (let i = 0; i < emails.length; i += 50) chunks.push(emails.slice(i, i + 50));
  for (const chunk of chunks) {
    await resend.emails.send({
      from: FROM,
      to: chunk,
      subject: `New drop available.`,
      html: newDropHtml(drop),
      text: newDropText(drop),
    });
  }
}

async function sendBroadcast(emails, subject, body) {
  if (!emails.length) return;
  const chunks = [];
  for (let i = 0; i < emails.length; i += 50) chunks.push(emails.slice(i, i + 50));
  for (const chunk of chunks) {
    await resend.emails.send({
      from: FROM,
      to: chunk,
      subject,
      html: broadcastHtml(subject, body),
      text: body,
    });
  }
}

async function sendDirectMessage(email, handle, subject, body) {
  return resend.emails.send({
    from: FROM,
    to: email,
    subject: subject || 'A message from Blank Labs',
    html: messageHtml(handle, body),
    text: body,
  });
}

async function sendOwnerAlert(subject, body) {
  if (!process.env.OWNER_EMAIL) return;
  return resend.emails.send({
    from: FROM,
    to: process.env.OWNER_EMAIL,
    subject: `[BL Alert] ${subject}`,
    html: `<pre style="font-family:monospace">${body}</pre>`,
    text: body,
  });
}

module.exports = { sendApproval, sendDenial, sendDropNotification, sendBroadcast, sendDirectMessage, sendOwnerAlert };
