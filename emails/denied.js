function deniedHtml() {
  return `<!DOCTYPE html><html><head><style>
  body{margin:0;padding:0;background:#F2EEE6;font-family:'Courier New',monospace;}
  .wrap{max-width:520px;margin:40px auto;background:#F2EEE6;border:1px solid #C8C4B8;padding:40px;}
  .logo{font-size:11px;letter-spacing:0.25em;text-transform:uppercase;color:#9A9890;margin-bottom:32px;}
  p{font-size:13px;line-height:1.8;color:#4A4A44;margin:0 0 16px;}
  </style></head><body><div class="wrap">
    <div class="logo">Blank Labs</div>
    <p>Your request was not approved at this time.</p>
  </div></body></html>`;
}
function deniedText() { return 'BLANK LABS\n\nYour request was not approved at this time.'; }
module.exports = { deniedHtml, deniedText };
