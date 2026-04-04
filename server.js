require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');

const app = express();

// ── Middleware ──────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // trust Cloudflare / Railway proxy
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api',       require('./routes/public'));
app.use('/api/member', require('./routes/member'));
app.use('/api/owner',  require('./routes/owner'));

// ── Auth check helpers ──────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');

function checkMember(req) {
  try {
    const t = req.cookies?.bl_member;
    if (!t) return null;
    const p = jwt.verify(t, process.env.JWT_SECRET);
    return p.role === 'member' ? p : null;
  } catch { return null; }
}

function checkOwner(req) {
  try {
    const t = req.cookies?.bl_owner;
    if (!t) return null;
    const p = jwt.verify(t, process.env.JWT_SECRET);
    return p.role === 'owner' ? p : null;
  } catch { return null; }
}

// ── Page routes ─────────────────────────────────────────────────────────────
// Member panel
app.get('/panel', (req, res) => {
  if (!checkMember(req)) return res.redirect('/?auth=required');
  res.sendFile(path.join(__dirname, 'views', 'member.html'));
});

// Owner panel — route from env var, defaults to /owner-panel
const ownerRoute = `/${process.env.OWNER_ROUTE || 'owner-panel'}`;
app.get(ownerRoute, (req, res) => {
  if (!checkOwner(req)) return res.redirect('/?auth=owner');
  res.sendFile(path.join(__dirname, 'views', 'owner.html'));
});

// Owner login page
app.get(`${ownerRoute}-login`, (req, res) => {
  // Serve owner login inline
  res.send(`<!DOCTYPE html>
<html><head>
<title>Blank Labs — Owner Access</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400&family=Barlow+Condensed:wght@500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0E0F0D;color:#F2EEE6;font-family:'DM Mono',monospace;
  display:flex;align-items:center;justify-content:center;min-height:100vh;}
.card{width:380px;border:1px solid #2e2e2e;padding:40px;}
.logo{font-family:'Barlow Condensed',sans-serif;font-size:13px;letter-spacing:0.22em;
  text-transform:uppercase;margin-bottom:32px;color:#9A9890;}
.badge{font-size:8px;letter-spacing:0.15em;background:#8B2020;color:#F2EEE6;padding:3px 7px;margin-left:8px;}
label{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#9A9890;display:block;margin-bottom:7px;}
input{width:100%;background:#0f0f0f;border:1px solid #2e2e2e;color:#F2EEE6;
  font-family:'DM Mono',monospace;font-size:13px;padding:12px 14px;outline:none;margin-bottom:16px;}
input:focus{border-color:#4A8A84;}
button{width:100%;background:#F2EEE6;color:#0E0F0D;font-family:'DM Mono',monospace;
  font-size:11px;letter-spacing:0.2em;text-transform:uppercase;padding:14px;border:none;cursor:pointer;}
button:hover{background:#4A8A84;color:#F2EEE6;}
.err{font-size:10px;color:#c07070;margin-top:8px;min-height:14px;}
</style>
</head>
<body><div class="card">
  <div class="logo">Blank Labs <span class="badge">Owner</span></div>
  <label for="pp">Owner Passphrase</label>
  <input type="password" id="pp" placeholder="••••••••••••" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">Authenticate</button>
  <div class="err" id="err"></div>
</div>
<script>
async function login(){
  const pp=document.getElementById('pp').value;
  const r=await fetch('/api/owner-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passphrase:pp})});
  const d=await r.json();
  if(d.ok){window.location='${ownerRoute}';}
  else{document.getElementById('err').textContent=d.error||'Failed.';}
}
</script></body></html>`);
});

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 404 ─────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  BLANK LABS running on port ${PORT}`);
  console.log(`  Owner panel: ${ownerRoute}`);
  console.log(`  NODE_ENV: ${process.env.NODE_ENV}\n`);
});
