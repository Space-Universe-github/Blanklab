// emails/approved.js
const BASE = `
  body{margin:0;padding:0;background:#F2EEE6;font-family:'Courier New',monospace;}
  .wrap{max-width:520px;margin:40px auto;background:#F2EEE6;border:1px solid #C8C4B8;padding:40px;}
  .logo{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#9A9890;margin-bottom:32px;}
  h2{font-family:Georgia,serif;font-size:22px;font-weight:300;color:#0E0F0D;margin:0 0 20px;}
  p{font-size:13px;line-height:1.8;color:#4A4A44;margin:0 0 16px;}
  .passphrase{background:#0E0F0D;color:#4A8A84;font-family:'Courier New',monospace;font-size:15px;
    letter-spacing:0.12em;padding:16px 20px;margin:20px 0;word-break:break-all;}
  .btn{display:inline-block;background:#2E5C58;color:#F2EEE6;font-family:'Courier New',monospace;
    font-size:11px;letter-spacing:0.18em;text-transform:uppercase;padding:12px 24px;
    text-decoration:none;margin:8px 0;}
  .footer{margin-top:32px;font-size:10px;letter-spacing:0.1em;color:#9A9890;border-top:1px solid #C8C4B8;padding-top:20px;}
`;

function approvedHtml(passphrase) {
  return `<!DOCTYPE html><html><head><style>${BASE}</style></head><body>
  <div class="wrap">
    <div class="logo">Blank Labs</div>
    <h2>You have been approved.</h2>
    <p>Your request to access the Blank Labs member network has been reviewed and approved.</p>
    <p>Your passphrase:</p>
    <div class="passphrase">${passphrase}</div>
    <p>Use it to log in at:</p>
    <a class="btn" href="${process.env.SITE_URL}">${process.env.SITE_URL} →</a>
    <div class="footer">
      Do not share this passphrase. It is unique to your account.<br>
      If you believe it has been compromised, reply to this email.
    </div>
  </div></body></html>`;
}

function approvedText(passphrase) {
  return `BLANK LABS — ACCESS APPROVED\n\nYour passphrase: ${passphrase}\n\nLog in at: ${process.env.SITE_URL}\n\nDo not share this passphrase.`;
}

module.exports = { approvedHtml, approvedText };
