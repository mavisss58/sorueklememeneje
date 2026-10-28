'use strict';
// Soru Ekleme - tablet eşleme + eşitleme (sunucu tarafı)
//
//  * Bilgisayar (127.0.0.1) : eşleme başlatır, cihazları yönetir.
//  * Tablet (yerel ağ)      : tek kullanımlık QR/kod ile eşleşir, sonra yalnızca çerezle yetkili olur.
//  * Eşitleme merkezi       : veritabani/senkron/ altında tutulur; bilgisayar ve tablet buna bağlanır.
//
// Güvenlik: yerel ağ dinleyicisi sadece eşleme başlatılınca (veya daha önce eşleşmiş cihaz varsa) açılır.
// Eşleşmemiş biri yalnızca eşleme sayfasını görür; API anahtarı, anahtar.env ve sunucu dosyaları hiçbir zaman verilmez.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CODE_TTL = 5 * 60 * 1000;      // kod 5 dakika geçerli
const MAX_CODE_TRIES = 5;            // bir kod için en fazla 5 yanlış deneme
const COOKIE = 'se_dev';

module.exports = function createEslesme(ctx) {
  const { ROOT, send, readBody, getMainPort } = ctx;
  const DB_DIR = path.join(ROOT, 'veritabani');
  const FILE = path.join(DB_DIR, 'eslesme.json');
  const HUB = path.join(DB_DIR, 'senkron');
  const REC = path.join(HUB, 'kayit');
  const INDEX = path.join(HUB, 'index.json');

  // ------------------------------------------------------------ kalıcı durum
  let state = { devices: [] };           // {id,name,hash,createdAt,lastSeen}
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) { /* ilk açılış */ }
  const saveState = () => {
    try { fs.mkdirSync(DB_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(state, null, 1)); } catch (e) { console.warn('[Eşleme] kaydedilemedi:', e.message); }
  };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const eqHex = (a, b) => { try { const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex'); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch (_) { return false; } };

  // ------------------------------------------------------------ eşleme kodu (bellekte, tek kullanımlık)
  let pending = null;                    // {code, token, expiresAt, tries}
  const ipFails = new Map();             // ip -> {n, until}
  let lastClaim = null;

  function newPending() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    pending = { code, token: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + CODE_TTL, tries: 0 };
    return pending;
  }
  const pendingAlive = () => { if (pending && pending.expiresAt <= Date.now()) pending = null; return pending; };

  // ------------------------------------------------------------ yerel ağ dinleyicisi
  let lanServer = null, lanPort = 0, lanHandler = null;

  function lanIps() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        if (/^169\.254\./.test(a.address)) continue;
        const virtual = /vethernet|virtual|vmware|vbox|docker|hyper-v|wsl|tailscale|zerotier/i.test(name);
        const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
        out.push({ ip: a.address, score: (priv ? 2 : 0) + (virtual ? -3 : 0) + (/wi-?fi|wlan|wireless/i.test(name) ? 1 : 0) });
      }
    }
    return out.sort((x, y) => y.score - x.score).map((x) => x.ip);
  }

  function startLan() {
    if (lanServer) return Promise.resolve(lanPort);
    return new Promise((resolve, reject) => {
      const base = (getMainPort() || 5500) + 100;
      let i = 0;
      const tryPort = () => {
        if (i > 9) return reject(new Error('Boş bir port bulunamadı'));
        const port = base + i++;
        const s = http.createServer((req, res) => lanHandler(req, res));
        s.once('error', (e) => { if (e.code === 'EADDRINUSE') tryPort(); else reject(e); });
        s.listen(port, '0.0.0.0', () => { lanServer = s; lanPort = port; console.log('  Tablet erişimi açık -> port ' + port + ' (yalnızca eşleşmiş cihazlar)'); resolve(port); });
      };
      tryPort();
    });
  }
  function stopLan() {
    if (!lanServer) return;
    try { lanServer.close(); if (lanServer.closeAllConnections) lanServer.closeAllConnections(); } catch (_) { /* yoksay */ }
    lanServer = null; lanPort = 0;
    console.log('  Tablet erişimi kapatıldı.');
  }
  const maybeStopLan = () => { if (!state.devices.length && !pendingAlive()) stopLan(); };
  setInterval(() => { pendingAlive(); if (lanServer) maybeStopLan(); }, 30000).unref();

  // ------------------------------------------------------------ yardımcılar
  function parseCookies(req) {
    const out = {};
    String(req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
    return out;
  }
  function deviceOf(req) {
    const tok = parseCookies(req)[COOKIE];
    if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
    const h = sha(tok);
    const d = state.devices.find((x) => eqHex(x.hash, h));
    if (d && Date.now() - (d.lastSeen || 0) > 60000) { d.lastSeen = Date.now(); saveState(); }
    return d || null;
  }
  const isLocalHost = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''));
  const reqIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const jsonBody = async (req) => { try { return JSON.parse(await readBody(req)) || {}; } catch (_) { return null; } };

  function deviceName(ua) {
    ua = String(ua || '');
    if (/iPad/i.test(ua)) return 'iPad';
    if (/iPhone/i.test(ua)) return 'iPhone';
    if (/Android/i.test(ua)) { const m = /;\s*([^;)]+?)\s*(Build|\))/.exec(ua); return (/Mobile/i.test(ua) ? 'Android telefon' : 'Android tablet') + (m && m[1] && !/^(wv|U)$/i.test(m[1]) ? ' (' + m[1].slice(0, 24) + ')' : ''); }
    if (/Windows/i.test(ua)) return 'Windows cihaz';
    if (/Macintosh/i.test(ua)) return 'Mac';
    return 'Tablet';
  }

  // ------------------------------------------------------------ eşitleme merkezi
  let index = null;
  function loadIndex() {
    if (index) return index;
    try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (_) { index = {}; }
    return index;
  }
  function saveIndex() {
    fs.mkdirSync(HUB, { recursive: true });
    fs.writeFileSync(INDEX + '.tmp', JSON.stringify(index));
    fs.renameSync(INDEX + '.tmp', INDEX);
  }
  const recFile = (key) => path.join(REC, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  const validKey = (k) => typeof k === 'string' && /^[qb]:[\w.\-:]{1,120}$/.test(k);

  function syncManifest(items) {
    const idx = loadIndex(), want = [], sendList = [];
    const seen = new Set();
    for (const key of Object.keys(items || {})) {
      if (!validKey(key)) continue;
      seen.add(key);
      const c = items[key] || [], cts = Number(c[0]) || 0, s = idx[key];
      if (!s || cts > s.ts) want.push(key);
      else if (s.ts > cts) sendList.push({ key, ts: s.ts, del: !!s.del });
    }
    for (const key of Object.keys(idx)) if (!seen.has(key)) sendList.push({ key, ts: idx[key].ts, del: !!idx[key].del });
    return { want, send: sendList, now: Date.now() };
  }
  function syncPush(records) {
    const idx = loadIndex();
    let n = 0;
    fs.mkdirSync(REC, { recursive: true });
    for (const r of records || []) {
      if (!r || !validKey(r.key)) continue;
      const ts = Number(r.ts) || 0, s = idx[r.key];
      if (s && ts <= s.ts) continue;
      if (r.del) { try { fs.unlinkSync(recFile(r.key)); } catch (_) { /* yok */ } idx[r.key] = { ts, del: 1 }; }
      else if (r.data && typeof r.data === 'object') { fs.writeFileSync(recFile(r.key), JSON.stringify(r.data)); idx[r.key] = { ts }; }
      else continue;
      n++;
    }
    if (n) saveIndex();
    return { saved: n };
  }
  function syncPull(keys) {
    const idx = loadIndex(), out = [];
    for (const key of (keys || []).slice(0, 40)) {
      if (!validKey(key) || !idx[key]) continue;
      if (idx[key].del) { out.push({ key, ts: idx[key].ts, del: true }); continue; }
      try { out.push({ key, ts: idx[key].ts, data: JSON.parse(fs.readFileSync(recFile(key), 'utf8')) }); } catch (_) { /* dosya yok */ }
    }
    return { records: out };
  }

  // ------------------------------------------------------------ eşleme sayfası (tablet, eşleşmemiş)
  const PAIR_PAGE = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Soru Ekleme - Eşleme</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0e1b36;color:#eaf0f9;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px}
.k{width:100%;max-width:420px;background:#1d2b4f;border:1px solid #31406a;border-radius:20px;padding:28px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#bccade;font-size:14px;line-height:1.6;margin:0 0 18px}
input{width:100%;font-size:32px;letter-spacing:.35em;text-align:center;padding:12px;border-radius:12px;border:1px solid #46557c;background:#0e1b36;color:#fff;outline:none}
input:focus{border-color:#818cf8}button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;background:#4f46e5;color:#fff;font-size:16px;font-weight:700}
button:disabled{opacity:.5}#h{color:#fca5a5;font-size:13px;min-height:20px;margin-top:12px}
</style></head><body><div class="k"><h1>Tablet Eşleme</h1>
<p id="m">Bilgisayardaki <b>Ayarlar → Tablet Eşleme</b> ekranında görünen 6 haneli kodu girin veya oradaki QR kodu okutun.</p>
<form id="f"><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="······" autofocus><button id="b">Eşle</button></form><div id="h"></div></div>
<script>
(function(){var q=new URLSearchParams(location.search),tok=q.get('eslesme'),h=document.getElementById('h'),b=document.getElementById('b'),c=document.getElementById('c');
function go(body){b.disabled=true;h.textContent='';
fetch('/api/eslesme/eslestir',{method:'POST',headers:{'Content-Type':'application/json','X-Soru-Istek':'1'},body:JSON.stringify(body)})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){
if(x.ok){document.getElementById('m').textContent='Eşleşti! Uygulama açılıyor...';history.replaceState(null,'','/');setTimeout(function(){location.replace('/')},600)}
else{h.textContent=x.j.error||'Eşleşme başarısız';b.disabled=false}}).catch(function(){h.textContent='Bilgisayara ulaşılamadı. Aynı Wi-Fi ağında mısınız?';b.disabled=false})}
document.getElementById('f').onsubmit=function(e){e.preventDefault();var v=c.value.replace(/\\D/g,'');if(v.length!==6){h.textContent='6 haneli kodu girin';return}go({code:v})};
if(tok){history.replaceState(null,'','/');go({token:tok})}})();
</script></body></html>`;

  // ------------------------------------------------------------ yönlendirme
  // true dönerse istek işlenmiştir. lan=true: yerel ağ dinleyicisinden gelen istek.
  async function route(req, res, url, lan) {
    const p = url.pathname;
    const isApi = p.startsWith('/api/eslesme/') || p.startsWith('/api/sync/');

    if (lan) {
      const dev = deviceOf(req);
      if (p === '/api/eslesme/eslestir' && req.method === 'POST') { await claim(req, res); return true; }
      if (!dev) {
        if (isApi || p.startsWith('/api/')) { send(res, 401, { error: 'Eşleşme gerekli' }); return true; }
        if (p === '/' || p === '/index.html') { send(res, 200, PAIR_PAGE, 'text/html; charset=utf-8'); return true; }
        send(res, 401, 'Eşleşme gerekli', 'text/plain; charset=utf-8'); return true;
      }
      req.seDevice = dev;
    } else if (isApi && !isLocalHost(req)) {          // DNS-rebinding koruması
      send(res, 403, { error: 'Yalnızca bu bilgisayardan' }); return true;
    }
    if (!isApi) return false;
    if (req.headers['x-soru-istek'] !== '1') { send(res, 403, { error: 'Geçersiz istek' }); return true; }

    // ---- eşleme yönetimi
    if (p === '/api/eslesme/durum' && req.method === 'GET') {
      if (lan) { send(res, 200, { role: 'tablet', device: { id: req.seDevice.id, name: req.seDevice.name }, now: Date.now() }); return true; }
      const pd = pendingAlive();
      send(res, 200, {
        role: 'pc', now: Date.now(),
        devices: state.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen })),
        pending: pd ? { expiresAt: pd.expiresAt } : null,
        lan: { running: !!lanServer, port: lanPort, ips: lanIps() },
        lastClaim,
      });
      return true;
    }
    if (lan) {
      if (p === '/api/eslesme/kaldir-ben' && req.method === 'POST') {
        state.devices = state.devices.filter((d) => d.id !== req.seDevice.id); saveState();
        send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
        setTimeout(maybeStopLan, 500);
        return true;
      }
    } else {
      if (p === '/api/eslesme/baslat' && req.method === 'POST') {
        try { await startLan(); } catch (e) { send(res, 500, { error: 'Yerel ağ erişimi açılamadı: ' + e.message }); return true; }
        const ips = lanIps();
        if (!ips.length) { send(res, 200, { error: 'Yerel ağ (Wi-Fi) bağlantısı bulunamadı. Bilgisayarın ağa bağlı olduğundan emin olun.' }); return true; }
        const pd = newPending();
        lastClaim = null;
        send(res, 200, { code: pd.code, expiresAt: pd.expiresAt, url: `http://${ips[0]}:${lanPort}/?eslesme=${pd.token}`, ips: ips.map((ip) => `http://${ip}:${lanPort}/`), now: Date.now() });
        return true;
      }
      if (p === '/api/eslesme/iptal' && req.method === 'POST') { pending = null; maybeStopLan(); send(res, 200, { ok: true }); return true; }
      if (p === '/api/eslesme/kaldir' && req.method === 'POST') {
        const b = await jsonBody(req);
        if (!b || typeof b.id !== 'string') { send(res, 400, { error: 'Geçersiz istek' }); return true; }
        state.devices = state.devices.filter((d) => d.id !== b.id); saveState(); maybeStopLan();
        send(res, 200, { ok: true }); return true;
      }
    }

    // ---- eşitleme (bilgisayar ve eşleşmiş tablet)
    if (p === '/api/sync/manifest' || p === '/api/sync/push' || p === '/api/sync/pull') {
      if (req.method !== 'POST') { send(res, 405, { error: 'POST gerekli' }); return true; }
      const b = await jsonBody(req);
      if (!b) { send(res, 400, { error: 'Geçersiz JSON' }); return true; }
      try {
        if (p.endsWith('manifest')) send(res, 200, syncManifest(b.items));
        else if (p.endsWith('push')) send(res, 200, syncPush(b.records));
        else send(res, 200, syncPull(b.keys));
      } catch (e) { send(res, 500, { error: 'Eşitleme hatası: ' + e.message }); }
      return true;
    }
    send(res, 404, { error: 'Bulunamadı' });
    return true;
  }

  async function claim(req, res) {
    const ip = reqIp(req);
    const f = ipFails.get(ip);
    if (f && f.until > Date.now()) { send(res, 429, { error: 'Çok fazla deneme. Bir dakika bekleyin.' }); return; }
    const b = await jsonBody(req);
    const pd = pendingAlive();
    if (!b || !pd) { send(res, 400, { error: 'Kodun süresi dolmuş. Bilgisayardan yeni kod oluşturun.' }); return; }
    const ok = (typeof b.token === 'string' && b.token.length === 32 && eqHex(Buffer.from(b.token).toString('hex'), Buffer.from(pd.token).toString('hex')))
      || (typeof b.code === 'string' && b.code.length === 6 && eqHex(Buffer.from(b.code).toString('hex'), Buffer.from(pd.code).toString('hex')));
    if (!ok) {
      pd.tries++;
      const e = ipFails.get(ip) || { n: 0, until: 0 }; e.n++; if (e.n >= 8) { e.until = Date.now() + 60000; e.n = 0; } ipFails.set(ip, e);
      if (pd.tries >= MAX_CODE_TRIES) { pending = null; send(res, 400, { error: 'Çok fazla yanlış deneme; kod iptal edildi. Yeni kod oluşturun.' }); return; }
      send(res, 400, { error: 'Kod yanlış. Kalan hak: ' + (MAX_CODE_TRIES - pd.tries) }); return;
    }
    pending = null;                                   // tek kullanımlık: hemen yakıldı
    const token = crypto.randomBytes(32).toString('hex');
    const dev = { id: crypto.randomBytes(6).toString('hex'), name: deviceName(req.headers['user-agent']), hash: sha(token), createdAt: Date.now(), lastSeen: Date.now() };
    state.devices.push(dev); saveState();
    lastClaim = { id: dev.id, name: dev.name, at: Date.now() };
    console.log('  Yeni cihaz eşleşti: ' + dev.name);
    send(res, 200, { ok: true, name: dev.name }, 'application/json; charset=utf-8',
      { 'Set-Cookie': `${COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict` });
  }

  // Açılışta: eşleşmiş cihaz varsa tablet erişimini hazırla.
  function init(handler) {
    lanHandler = handler;
    if (state.devices.length) startLan().catch((e) => console.warn('[Eşleme] tablet erişimi açılamadı:', e.message));
  }

  return { route, init, stop: stopLan };
};
