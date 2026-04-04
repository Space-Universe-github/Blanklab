function broadcastHtml(subject, body) {
  const escaped = body.replace(/\n/g,'<br>');
  return `<!DOCTYPE html><html><head><style>
  body{margin:0;padding:0;background:#F2EEE6;font-family:'Courier New',monospace;}
  .wrap{max-width:520px;margin:40px auto;background:#F2EEE6;border:1px solid #C8C4B8;padding:40px;}
  .logo{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#9A9890;margin-bottom:32px;}
  h2{font-family:Georgia,serif;font-size:18px;font-weight:300;color:#0E0F0D;margin:0 0 20px;}
  .body{font-size:14px;line-height:1.85;color:#4A4A44;font-family:Georgia,serif;}
  .footer{margin-top:32px;font-size:10px;letter-spacing:0.08em;color:#9A9890;border-top:1px solid #C8C4B8;padding-top:20px;}
  </style></head><body><div class="wrap">
    <div class="logo">Blank Labs</div>
    <h2>${subject}</h2>
    <div class="body">${escaped}</div>
    <div class="footer">This is a message from the Blank Labs operator.</div>
  </div></body></html>`;
}
module.exports = { broadcastHtml };
