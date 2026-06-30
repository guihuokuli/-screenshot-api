const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '.data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 200;

class Cache {
  constructor(max = CACHE_MAX, ttl = CACHE_TTL) {
    this.store = new Map(); this.max = max; this.ttl = ttl;
  }
  get(k) {
    const v = this.store.get(k);
    if (!v) return null;
    if (Date.now() - v.t > this.ttl) { this.store.delete(k); return null; }
    return v.d;
  }
  set(k, d) {
    if (this.store.size >= this.max) this.store.delete(this.store.keys().next().value);
    this.store.set(k, { d, t: Date.now() });
  }
  stats() { return { size: this.store.size, max: this.max, ttlMs: this.ttl }; }
}
const cache = new Cache();

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(KEYS_FILE)) fs.writeFileSync(KEYS_FILE, JSON.stringify({ admin: '', keys: {} }, null, 2));
function loadKeys() { try { return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch { return { admin: '', keys: {} }; } }
function saveKeys(d) { fs.writeFileSync(KEYS_FILE, JSON.stringify(d, null, 2)); }
function genKey() { return 'sk-' + crypto.randomBytes(24).toString('hex'); }

function createKey(plan, label) {
  const d = loadKeys();
  const k = genKey();
  d.keys[k] = { plan: plan || 'free', label: label || '', created: new Date().toISOString(), usage: { total: 0, today: 0, date: new Date().toISOString().slice(0, 10) }, enabled: true };
  saveKeys(d);
  return k;
}

function validateKey(apiKey) {
  const d = loadKeys();
  const e = d.keys[apiKey];
  if (!e || !e.enabled) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (e.usage.date !== today) { e.usage.today = 0; e.usage.date = today; }
  const limits = { free: 30, pro: 5000 };
  if (e.usage.today >= (limits[e.plan] || 100)) return null;
  e.usage.total++; e.usage.today++;
  saveKeys(d);
  return { plan: e.plan, usage: e.usage, label: e.label };
}

function getAdminKey() {
  let d = loadKeys();
  if (!d.admin) { d.admin = crypto.randomBytes(16).toString('hex'); saveKeys(d); }
  return d.admin;
}

function auth(req, res, next) {
  const k = req.headers['x-api-key'] || req.query.api_key;
  if (!k) return res.status(401).json({ error: 'API key required' });
  const r = validateKey(k);
  if (!r) return res.status(403).json({ error: 'Invalid or exhausted API key' });
  req.keyInfo = r;
  next();
}

function admin(req, res, next) {
  const k = req.headers['x-admin-key'] || req.query.admin_key;
  if (!k || k !== loadKeys().admin) return res.status(403).json({ error: 'Admin key required' });
  next();
}

let browser = null;
async function getBrowser() {
  try { if (browser && browser.isConnected()) return browser; } catch {}
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return browser;
}

function isURL(s) { try { new URL(s); return true; } catch { return false; } }
function cacheKey(url, opts) { return crypto.createHash('md5').update(url + JSON.stringify(opts)).digest('hex'); }
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildCardHTML(meta, options = {}) {
  const { darkMode = false, logo = '' } = options;
  const title = (meta.title || meta.ogTitle || 'Untitled').slice(0, 120);
  const desc = (meta.description || meta.ogDescription || '').slice(0, 200);
  const domain = meta.domain || '';
  const siteName = meta.ogSiteName || domain || '';
  const palettes = [
    { bg: '#f0f4ff', ac: '#6366f1', tx: '#1a1a2e', su: '#555', ca: '#fff' },
    { bg: '#fdf2f8', ac: '#ec4899', tx: '#1a1a2e', su: '#555', ca: '#fff' },
    { bg: '#f0fdf4', ac: '#22c55e', tx: '#1a1a2e', su: '#555', ca: '#fff' },
    { bg: '#fff7ed', ac: '#f97316', tx: '#1a1a2e', su: '#555', ca: '#fff' },
    { bg: '#eff6ff', ac: '#3b82f6', tx: '#1a1a2e', su: '#555', ca: '#fff' },
    { bg: '#f5f3ff', ac: '#8b5cf6', tx: '#1a1a2e', su: '#555', ca: '#fff' },
  ];
  const pal = palettes[Math.abs(domain + title).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % palettes.length];
  const bg = darkMode ? '#0f172a' : pal.bg;
  const cardBg = darkMode ? '#1e293b' : pal.ca;
  const titleColor = darkMode ? '#f1f5f9' : pal.tx;
  const subColor = darkMode ? '#94a3b8' : pal.su;
  const agGlow = darkMode ? `${pal.ac}33` : `${pal.ac}22`;
  const borderColor = darkMode ? '#334155' : '#eee';
  let logoHTML = '';
  if (logo) {
    const logoSrc = logo.startsWith('data:') ? logo : (isURL(logo) ? logo : '');
    if (logoSrc) logoHTML = `<img src="${esc(logoSrc)}" style="height:40px;max-width:200px;object-fit:contain;margin-right:16px;vertical-align:middle">`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;width:1200px;height:630px;background:${bg};display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif"><div style="background:${cardBg};width:1040px;min-height:400px;border-radius:24px;box-shadow:0 30px 80px ${agGlow};padding:60px 70px;position:relative;overflow:hidden"><div style="position:absolute;top:0;left:0;right:0;height:6px;background:${pal.ac}"></div><div style="display:flex;align-items:center;margin-bottom:24px">${logoHTML}<span style="font-size:20px;color:${pal.ac};font-weight:600;letter-spacing:0.5px">${esc(siteName)}</span></div><h1 style="font-size:52px;font-weight:800;color:${titleColor};margin:0 0 24px 0;line-height:1.15;letter-spacing:-0.5px;word-break:break-word">${esc(title)}</h1>${desc ? `<p style="font-size:26px;color:${subColor};margin:0 0 32px 0;line-height:1.5;word-break:break-word">${esc(desc)}</p>` : ''}<div style="position:absolute;bottom:40px;left:70px;right:70px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid ${borderColor};padding-top:24px"><span style="font-size:18px;color:${darkMode?'#64748b':'#999'}">${esc(domain)}</span><span style="font-size:16px;color:${darkMode?'#475569':'#bbb'}">Generated by ScreenshotAPI</span></div></div></body></html>`;
}

async function takeScreenshot(url, opts = {}) {
  const { width = 1280, height = 720, fullPage = false, format = 'png', quality = 90, delay = 0, selector = '' } = opts;
  const ck = cacheKey(url, opts);
  const cached = cache.get(ck);
  if (cached) return { ...cached, cached: true };
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width, height });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    let imageData;
    if (selector) {
      const el = await page.waitForSelector(selector, { timeout: 15000 });
      if (!el) return { error: `Selector "${selector}" not found`, cached: false };
      const box = await el.boundingBox();
      if (!box) return { error: `Element "${selector}" is not visible`, cached: false };
      imageData = await el.screenshot({ type: format === 'jpeg' ? 'jpeg' : 'png', quality: format === 'jpeg' ? quality : undefined });
    } else {
      const f = format === 'jpeg' ? 'jpeg' : 'png';
      const so = { type: f, fullPage };
      if (f === 'jpeg') so.quality = quality;
      imageData = await page.screenshot(so);
    }
    const f = format === 'jpeg' ? 'jpeg' : 'png';
    const r = { data: imageData, contentType: `image/${f}`, cached: false };
    cache.set(ck, r);
    return r;
  } finally { await page.close().catch(() => {}); }
}

async function generateSocialCard(url, opts = {}) {
  const { darkMode = false, logo = '' } = opts;
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const meta = await page.evaluate(() => {
      const gm = (prop) => {
        const el = document.querySelector(`meta[property="og:${prop}"],meta[name="og:${prop}"]`);
        return el ? el.getAttribute('content') : '';
      };
      return {
        ogTitle: gm('title'), ogDescription: gm('description'), ogImage: gm('image'),
        ogSiteName: gm('site_name'), title: document.title || '',
        description: (document.querySelector('meta[name="description"]') || {}).content || '',
        domain: window.location.hostname,
      };
    });
    const html = buildCardHTML(meta, { darkMode, logo });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 10000 });
    await page.setViewport({ width: 1200, height: 630 });
    return { data: await page.screenshot({ type: 'png' }), contentType: 'image/png', meta };
  } finally { await page.close().catch(() => {}); }
}

// ==================== 首页 ====================
app.get('/', (_, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScreenshotAPI — Website Screenshots & Social Cards</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',sans-serif;color:#1a1a2e;line-height:1.6}
.hero{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%);color:#fff;padding:100px 20px;text-align:center}
.hero h1{font-size:48px;font-weight:800;margin-bottom:16px;letter-spacing:-1px}
.hero p{font-size:20px;opacity:.9;max-width:600px;margin:0 auto 32px}
.hero a{display:inline-block;background:#fff;color:#6366f1;padding:14px 36px;border-radius:8px;font-weight:700;text-decoration:none;font-size:18px;transition:transform .2s;margin:4px}
.hero a:hover{transform:translateY(-2px)}
.hero a.outline{background:rgba(255,255,255,.2);color:#fff}
.section{padding:80px 20px;max-width:1100px;margin:0 auto}
.section h2{font-size:36px;text-align:center;margin-bottom:48px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:32px}
.card{background:#f8fafc;border-radius:12px;padding:32px;border:1px solid #e2e8f0;transition:box-shadow .2s}
.card:hover{box-shadow:0 8px 30px rgba(0,0,0,0.08)}
.card h3{font-size:22px;margin-bottom:12px}
.card p{color:#64748b;font-size:16px}
.card .icon{font-size:36px;margin-bottom:16px}
.pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
.plan{background:#fff;border-radius:12px;padding:40px 32px;border:2px solid #e2e8f0;text-align:center;transition:border-color .2s}
.plan:hover{border-color:#6366f1}
.plan h3{font-size:24px;margin-bottom:8px}
.plan .price{font-size:48px;font-weight:800;color:#6366f1;margin:16px 0}
.plan .price span{font-size:18px;font-weight:400;color:#94a3b8}
.plan ul{list-style:none;margin:24px 0;color:#64748b}
.plan ul li{padding:8px 0;border-bottom:1px solid #f1f5f9}
.plan a{display:inline-block;background:#6366f1;color:#fff;padding:12px 32px;border-radius:8px;font-weight:700;text-decoration:none;margin-top:16px;cursor:pointer}
.plan.pro{border-color:#6366f1;box-shadow:0 4px 20px rgba(99,102,241,0.15)}
.cta-box{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border-radius:16px;padding:60px 40px;max-width:700px;margin:0 auto}
.cta-box h2{font-size:32px;margin-bottom:16px}
.cta-box p{font-size:18px;opacity:.9;margin-bottom:32px}
.cta-box .email-box{background:#fff;color:#1a1a2e;display:inline-block;padding:16px 40px;border-radius:12px;font-size:20px;font-weight:700}
.cta-box .email-box a{color:#6366f1;text-decoration:none;cursor:pointer}
footer{background:#f8fafc;text-align:center;padding:40px 20px;color:#94a3b8;font-size:14px}
footer a{color:#6366f1}
code{background:#f1f5f9;padding:2px 8px;border-radius:4px;font-size:14px;color:#6366f1}
</style>
</head>
<body>
<div class="hero">
<h1>Screenshot &amp; Social Card API</h1>
<p>Convert any URL to high-quality screenshots or beautiful social cards. Full page, element selector, PDF, light/dark modes — one API call.</p>
<a href="#pricing">View Pricing</a>
<a href="/docs" class="outline">API Docs</a>
</div>
<div class="section">
<h2>What You Get</h2>
<div class="features">
<div class="card"><div class="icon">📸</div><h3>URL Screenshot</h3><p>PNG, JPEG, full-page or single-element capture. Custom viewport, delay, and quality.</p></div>
<div class="card"><div class="icon">🎯</div><h3>Element Selector</h3><p>Capture a specific element with CSS selector — only the hero section, chart, or widget you need.</p></div>
<div class="card"><div class="icon">🃏</div><h3>Social Card Generator</h3><p>Auto-extract OG metadata. 1200x630 share cards with light/dark modes and custom logo.</p></div>
<div class="card"><div class="icon">📄</div><h3>PDF Export</h3><p>Convert any webpage to A4 PDF with print backgrounds. Invoices, reports, archiving.</p></div>
<div class="card"><div class="icon">⚡</div><h3>Smart Caching</h3><p>Identical requests return instantly. 5-min TTL saves bandwidth and speeds up dev loops.</p></div>
<div class="card"><div class="icon">🔑</div><h3>API Key Auth</h3><p>Key-based authentication with rate limits. Free tier: 30 requests/day. CORS enabled.</p></div>
</div>
</div>
<div class="section" id="pricing">
<h2>Simple Pricing</h2>
<div class="pricing">
<div class="plan"><h3>Free</h3><div class="price">$0<span>/mo</span></div><ul><li>30 requests / day</li><li>Screenshot API</li><li>Element Selector</li><li>Social Card API</li><li>CORS enabled</li></ul><a href="/docs#get-key">Get Free Key</a></div>
<div class="plan pro"><h3>Pro</h3><div class="price">$9<span>/mo</span></div><ul><li>5,000 requests / day</li><li>Everything in Free</li><li>PDF export</li><li>Priority support</li><li>No watermark</li></ul><a href="#" onclick="alert('Email us at cyx9501@qq.com to get your Pro key. We reply within 24 hours with setup instructions.')">Get Pro</a></div>
</div>
</div>

<div class="section" style="text-align:center">
<div class="cta-box">
<h2>Ready to Go?</h2>
<p>Pro plan available now. Email us to get your API key — we will set you up manually. First 10 customers get Pro for free.</p>
<div class="email-box">
📧 <a href="#" onclick="alert('Email us at cyx9501@qq.com to get your Pro key. First 10 customers get Pro for free!')">cyx9501@qq.com</a>
</div>
<p style="margin-top:16px;opacity:.7;font-size:14px">We reply within 24 hours with your API key and setup instructions.</p>
</div>
</div>

<footer>
<p>&copy; 2026 ScreenshotAPI. | <a href="/terms">Terms</a> | <a href="/privacy">Privacy</a> | <a href="/refund">Refund</a></p>
<p style="margin-top:8px">Contact: <code>cyx9501@qq.com</code></p>
</footer>
</body></html>`));

// ==================== API 文档页 ====================
app.get('/docs', (_, res) => res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Docs — ScreenshotAPI</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',monospace;color:#1a1a2e;line-height:1.6;background:#f8fafc}
header{background:#1a1a2e;color:#fff;padding:24px 20px;text-align:center}
header h1{font-size:28px}header a{color:#818cf8}
.container{max-width:1000px;margin:0 auto;padding:40px 20px}
.endpoint{background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;border:1px solid #e2e8f0}
.endpoint h3{font-size:20px;margin-bottom:8px}
.endpoint .method{display:inline-block;padding:4px 12px;border-radius:4px;font-size:13px;font-weight:700;margin-right:8px}
.get{background:#dbeafe;color:#1d4ed8}.post{background:#dcfce7;color:#16a34a}
.endpoint .path{font-family:monospace;font-size:17px;color:#6366f1}
.endpoint p{color:#64748b;margin:12px 0}
pre{background:#1e293b;color:#e2e8f0;padding:20px;border-radius:8px;overflow-x:auto;font-size:14px;line-height:1.5}
pre .key{color:#facc15}pre .str{color:#a5d6ff}pre .com{color:#64748b}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #e2e8f0;font-size:14px}
th{background:#f1f5f9;font-weight:600}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;margin-left:6px}
.newtag{background:#fef3c7;color:#d97706}
.keygen{background:#f0fdf4;border:2px solid #22c55e;border-radius:12px;padding:24px;margin-bottom:24px;text-align:center}
.keygen button{background:#22c55e;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:18px;font-weight:700;cursor:pointer;margin-top:12px}
.keygen button:hover{background:#16a34a}
.keygen .result{margin-top:16px;padding:16px;background:#1e293b;color:#a5d6ff;border-radius:8px;word-break:break-all;display:none;font-size:14px}
.keygen .result.show{display:block}
</style>
</head>
<body>
<header>
<h1>📡 ScreenshotAPI Documentation</h1>
<p style="margin-top:8px;opacity:.8">Base URL: <code>https://158.247.230.116.nip.io</code></p>
<p><a href="/">← Back to Home</a></p>
</header>
<div class="container">

<div class="keygen" id="get-key">
<h3>🆓 Get Your Free API Key</h3>
<p style="color:#64748b">No email required. One click, get a key instantly. 30 requests/day.</p>
<button onclick="genKey()">Generate My Key</button>
<div class="result" id="keyResult"></div>
</div>
<script>
async function genKey(){
  var btn=document.querySelector('.keygen button');
  btn.textContent='Generating...';btn.disabled=true;
  try{
    var res=await fetch('/register',{method:'POST'});
    var data=await res.json();
    var d=document.getElementById('keyResult');
    d.classList.add('show');
    d.innerHTML='<strong>Your API Key:</strong><br><code style="color:#facc15;font-size:16px">'+data.api_key+'</code><br><br>Plan: <strong>'+data.plan+'</strong> | Limit: 30 req/day<br><br>Example:<br><code>curl "https://158.247.230.116.nip.io/screenshot?url=https://example.com&api_key='+data.api_key+'"</code><br><br><em style="color:#64748b">Save this key! It will not be shown again.</em>';
  }catch(e){
    alert('Failed to generate key. Please try again.');
  }
  btn.textContent='Generate My Key';btn.disabled=false;
}
</script>

<div class="endpoint">
<h3><span class="method get">GET</span><span class="path">/health</span></h3>
<p>Check API status. No authentication required.</p>
<pre>curl https://158.247.230.116.nip.io/health
<span class="com">→ {"status":"ok","uptime":"5912","cache":{"size":3},"keysIssued":1}</span></pre>
</div>

<div class="endpoint">
<h3><span class="method get">GET</span><span class="path">/screenshot</span></h3>
<p>Take a screenshot. Requires API key.</p>
<table><tr><th>Parameter</th><th>Type</th><th>Default</th><th>Description</th></tr>
<tr><td>url</td><td>string</td><td><em>required</em></td><td>Target URL</td></tr>
<tr><td>api_key</td><td>string</td><td><em>required</em></td><td>Your API key</td></tr>
<tr><td>width</td><td>number</td><td>1280</td><td>Viewport width</td></tr>
<tr><td>height</td><td>number</td><td>720</td><td>Viewport height</td></tr>
<tr><td>fullPage</td><td>bool</td><td>false</td><td>Capture full scrollable page</td></tr>
<tr><td>selector</td><td>string</td><td>""</td><td>CSS selector for element capture</td></tr>
<tr><td>format</td><td>string</td><td>png</td><td>png or jpeg</td></tr>
<tr><td>quality</td><td>number</td><td>90</td><td>JPEG quality (1-100)</td></tr>
<tr><td>delay</td><td>number</td><td>0</td><td>Wait ms before capture</td></tr>
</table>
<pre>curl "https://158.247.230.116.nip.io/screenshot?url=https://example.com&api_key=<span class="key">YOUR_KEY</span>"</pre>
<pre><span class="com"># Element selector — capture only the header:</span>
curl "https://158.247.230.116.nip.io/screenshot?url=https://example.com&selector=h1&api_key=<span class="key">YOUR_KEY</span>"</pre>
</div>

<div class="endpoint">
<h3><span class="method post">POST</span><span class="path">/screenshot</span></h3>
<p>JSON body version. Supports PDF + element selector.</p>
<pre>curl -X POST https://158.247.230.116.nip.io/screenshot \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <span class="key">YOUR_KEY</span>" \
  -d '{"url":"https://example.com","selector":".hero","format":"png"}'</pre>
<pre><span class="com"># PDF:</span>
curl -X POST https://158.247.230.116.nip.io/screenshot \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <span class="key">YOUR_KEY</span>" \
  -d '{"url":"https://example.com","pdf":true}'</pre>
</div>

<div class="endpoint">
<h3><span class="method post">POST</span><span class="path">/social-card</span></h3>
<p>Generate OG social card (1200x630). Light/dark modes. Custom logo.</p>
<table><tr><th>Parameter</th><th>Type</th><th>Default</th><th>Description</th></tr>
<tr><td>url</td><td>string</td><td><em>required</em></td><td>Target URL for OG extraction</td></tr>
<tr><td>dark_mode</td><td>bool</td><td>false</td><td>Dark theme card</td></tr>
<tr><td>logo</td><td>string</td><td>""</td><td>URL or base64 logo image</td></tr>
</table>
<pre>curl -X POST https://158.247.230.116.nip.io/social-card \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <span class="key">YOUR_KEY</span>" \
  -d '{"url":"https://github.com","dark_mode":false}'</pre>
</div>

<div class="endpoint">
<h3><span class="method post">POST</span><span class="path">/register</span></h3>
<p>Register for a free API key. No auth required. Rate-limited per IP (3/hour).</p>
<pre>curl -X POST https://158.247.230.116.nip.io/register
<span class="com">→ {"api_key":"sk-...","plan":"free","limit":"30 requests/day"}</span></pre>
</div>

<div class="endpoint">
<h3><span class="method get">GET</span><span class="path">/openapi.json</span></h3>
<p>OpenAPI 3.0 specification for third-party integrations.</p>
<pre>curl https://158.247.230.116.nip.io/openapi.json
<span class="com">→ {... complete API specification ...}</span></pre>
</div>

</div>
</body></html>`));

// ==================== OpenAPI 端点（供第三方平台接入） ====================
app.get('/openapi.json', (_, res) => res.json({
  openapi: '3.0.0',
  info: {
    title: 'ScreenshotAPI',
    version: '1.0.0',
    description: 'High-quality website screenshot and social card API. PNG/JPEG/PDF, element selector, full-page capture, light/dark social cards. Free tier: 30 req/day.',
    contact: { email: 'cyx9501@qq.com' },
  },
  servers: [{ url: 'https://158.247.230.116.nip.io', description: 'Production' }],
  paths: {
    '/screenshot': {
      get: {
        summary: 'Take screenshot (GET)',
        parameters: [
          { name: 'url', in: 'query', required: true, schema: { type: 'string' }, description: 'Target URL' },
          { name: 'api_key', in: 'query', required: true, schema: { type: 'string' }, description: 'API key' },
          { name: 'width', in: 'query', schema: { type: 'integer', default: 1280 } },
          { name: 'height', in: 'query', schema: { type: 'integer', default: 720 } },
          { name: 'fullPage', in: 'query', schema: { type: 'boolean', default: false } },
          { name: 'selector', in: 'query', schema: { type: 'string' }, description: 'CSS selector for element capture' },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['png', 'jpeg'], default: 'png' } },
          { name: 'delay', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { '200': { description: 'Image (PNG/JPEG)', headers: { 'X-Cache': { schema: { type: 'string' } }, 'X-Time-Ms': { schema: { type: 'string' } } } }, '401': { description: 'Missing API key' }, '403': { description: 'Quota exceeded' } },
      },
      post: {
        summary: 'Take screenshot (POST, supports PDF)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, fullPage: { type: 'boolean' }, selector: { type: 'string' }, format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'integer' }, pdf: { type: 'boolean' }, delay: { type: 'integer' } }, required: ['url'] } } } },
        responses: { '200': { description: 'Image or PDF' } },
      },
    },
    '/social-card': {
      post: {
        summary: 'Generate Open Graph social card (1200x630)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' }, dark_mode: { type: 'boolean' }, logo: { type: 'string' } }, required: ['url'] } } } },
        responses: { '200': { description: 'PNG card image' } },
      },
    },
    '/register': { post: { summary: 'Get free API key (30 req/day, 3/hour per IP)', responses: { '200': { description: 'API key' }, '429': { description: 'Rate limited' } } } },
    '/health': { get: { summary: 'Health check', responses: { '200': { description: 'Status' } } } },
  },
}));

app.get('/health', (_, res) => res.json({
  status: 'ok', uptime: process.uptime().toFixed(1),
  cache: cache.stats(), keysIssued: Object.keys(loadKeys().keys).length,
  cors: 'enabled', selectorSupport: 'enabled', freeLimit: '30/day',
}));

app.get('/card-preview', (_, res) => res.sendFile('/root/social-card-test.png'));

app.get('/terms', (_, res) => res.type('html').send(`<!DOCTYPE html><html><head><title>Terms</title></head><body><h1>Terms of Service</h1><p>By using ScreenshotAPI, you agree not to use it for illegal purposes. Service provided "as is".</p><p><a href="/">Back</a></p></body></html>`));
app.get('/privacy', (_, res) => res.type('html').send(`<!DOCTYPE html><html><head><title>Privacy</title></head><body><h1>Privacy Policy</h1><p>URLs are processed in memory and discarded. No data stored. No tracking.</p><p><a href="/">Back</a></p></body></html>`));
app.get('/refund', (_, res) => res.type('html').send(`<!DOCTYPE html><html><head><title>Refund</title></head><body><h1>Refund Policy</h1><p>Contact us within 7 days for a full refund of your most recent monthly payment.</p><p><a href="/">Back</a></p></body></html>`));

// ==================== 自动注册 Key ====================
const regIPs = new Map();
app.post('/register', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = regIPs.get(ip);
  if (rec && now - rec.time < 3600000 && rec.count >= 3) {
    return res.status(429).json({ error: 'Too many keys from this IP. Try again later.' });
  }
  if (!rec || now - rec.time >= 3600000) {
    regIPs.set(ip, { count: 1, time: now });
  } else {
    rec.count++;
  }
  const k = createKey('free', 'self-register');
  res.json({ api_key: k, plan: 'free', limit: '30 requests/day' });
});

// ==================== 截图 ====================
app.get('/screenshot', auth, async (req, res) => {
  const { url, width, height, fullPage, selector, format, quality, delay } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!isURL(url)) return res.status(400).json({ error: 'invalid url' });
  const t0 = Date.now();
  try {
    const r = await takeScreenshot(url, { width: parseInt(width) || 1280, height: parseInt(height) || 720, fullPage: fullPage === 'true' || fullPage === '1', format: format || 'png', quality: parseInt(quality) || 90, delay: parseInt(delay) || 0, selector: selector || '' });
    if (r.error) return res.status(404).json({ error: r.error });
    res.set('Content-Type', r.contentType); res.set('X-Time-Ms', String(Date.now() - t0)); res.set('X-Cache', r.cached ? 'HIT' : 'MISS');
    if (selector) res.set('X-Selector', selector);
    res.send(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/screenshot', auth, async (req, res) => {
  const { url, width, height, fullPage, selector, format, quality, pdf, delay } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!isURL(url)) return res.status(400).json({ error: 'invalid url' });
  const t0 = Date.now();
  try {
    if (pdf) {
      const b = await getBrowser(); const pg = await b.newPage();
      try { await pg.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); const buf = await pg.pdf({ format: 'A4', printBackground: true }); res.set('Content-Type', 'application/pdf'); res.set('X-Time-Ms', String(Date.now() - t0)); return res.send(buf); }
      finally { await pg.close().catch(() => {}); }
    }
    const r = await takeScreenshot(url, { width: parseInt(width) || 1280, height: parseInt(height) || 720, fullPage: !!fullPage, format: format || 'png', quality: parseInt(quality) || 90, delay: parseInt(delay) || 0, selector: selector || '' });
    if (r.error) return res.status(404).json({ error: r.error });
    res.set('Content-Type', r.contentType); res.set('X-Time-Ms', String(Date.now() - t0)); res.set('X-Cache', r.cached ? 'HIT' : 'MISS');
    if (selector) res.set('X-Selector', selector);
    res.send(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 社交卡片 ====================
app.post('/social-card', auth, async (req, res) => {
  const { url, dark_mode, logo } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!isURL(url)) return res.status(400).json({ error: 'invalid url' });
  const ck = 'card:' + crypto.createHash('md5').update(url + JSON.stringify({ dark_mode, logo })).digest('hex');
  const cached = cache.get(ck);
  if (cached) { res.set('Content-Type', cached.contentType); res.set('X-Cache', 'HIT'); return res.send(cached.data); }
  const t0 = Date.now();
  try {
    const r = await generateSocialCard(url, { darkMode: !!dark_mode, logo: logo || '' });
    cache.set(ck, r);
    res.set('Content-Type', r.contentType); res.set('X-Time-Ms', String(Date.now() - t0)); res.set('X-Cache', 'MISS');
    res.set('X-Card-Title', (r.meta.ogTitle || r.meta.title || '').slice(0, 100));
    res.send(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==================== 管理端点 ====================
app.post('/admin/create-key', admin, (req, res) => {
  const { plan, label } = req.body;
  const k = createKey(plan || 'free', label || '');
  res.json({ api_key: k, plan: plan || 'free', label: label || '' });
});

app.get('/admin/keys', admin, (_, res) => {
  const d = loadKeys();
  const ks = Object.entries(d.keys).map(([k, v]) => ({ key: k.slice(0, 12) + '...' + k.slice(-8), plan: v.plan, label: v.label, usage: v.usage, enabled: v.enabled, created: v.created }));
  res.json({ count: ks.length, keys: ks });
});

app.get('/admin/usage', admin, (_, res) => {
  const d = loadKeys();
  res.json({ totalRequests: Object.values(d.keys).reduce((s, v) => s + v.usage.total, 0), todayRequests: Object.values(d.keys).reduce((s, v) => s + v.usage.today, 0), activeKeys: Object.keys(d.keys).length });
});

app.listen(PORT, '0.0.0.0', () => console.log(`\nv5 running on :${PORT}  |  Admin Key: ${getAdminKey()}\n`));

process.on('SIGINT', async () => { if (browser) await browser.close().catch(() => {}); process.exit(0); });
