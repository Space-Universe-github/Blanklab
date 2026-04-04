function newDropHtml(drop) {
  return `<!DOCTYPE html><html><head><style>
  body{margin:0;padding:0;background:#F2EEE6;font-family:'Courier New',monospace;}
  .wrap{max-width:520px;margin:40px auto;background:#F2EEE6;border:1px solid #C8C4B8;padding:40px;}
  .logo{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#9A9890;margin-bottom:32px;}
  .type{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;background:#D4E8E6;color:#2E5C58;padding:3px 8px;display:inline-block;margin-bottom:14px;}
  h2{font-family:Georgia,serif;font-size:20px;font-weight:300;color:#0E0F0D;margin:0 0 16px;text-transform:uppercase;letter-spacing:0.06em;}
  p{font-size:13px;line-height:1.8;color:#4A4A44;margin:0 0 16px;}
  .btn{display:inline-block;background:#2E5C58;color:#F2EEE6;font-family:'Courier New',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;padding:12px 24px;text-decoration:none;margin:8px 0;}
  .footer{margin-top:32px;font-size:10px;letter-spacing:0.08em;color:#9A9890;border-top:1px solid #C8C4B8;padding-top:20px;}
  </style></head><body><div class="wrap">
    <div class="logo">Blank Labs — Drop #${drop.issue_number}</div>
    <div class="type">${drop.type}</div>
    <h2>${drop.title}</h2>
    <p>A new drop is available in the member feed. Log in to read it.</p>
    <a class="btn" href="${process.env.SITE_URL}/panel">Read Drop →</a>
    <div class="footer">You are receiving this because you opted into drop notifications.<br>To unsubscribe: log in and update your notification preferences.</div>
  </div></body></html>`;
}
function newDropText(drop) {
  return `BLANK LABS — Drop #${drop.issue_number}\n\n${drop.title}\n\nLog in to read: ${process.env.SITE_URL}/panel`;
}
module.exports = { newDropHtml, newDropText };
