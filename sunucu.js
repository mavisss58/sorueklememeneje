#!/usr/bin/env node
// Soru Ekleme - yerel sunucu (bağımlılık gerektirmez, sadece Node.js 18+)
//  - Uygulama dosyalarını sunar
//  - /api/analyze-question : soru görselinden ders + konu tespiti (Gemini veya Claude)
//
// API anahtarı: "anahtar.env" dosyasına yazılır (bkz. anahtar.ornek.env)
//   GEMINI_API_KEY=...        (ücretsiz: https://aistudio.google.com/apikey)
//   ANTHROPIC_API_KEY=...     (isteğe bağlı: https://console.anthropic.com)
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORTS = [5500, 5501, 5502, 5503, 8080];

// ---------------------------------------------------------------- ayarlar
function loadEnvFile() {
  const file = path.join(ROOT, 'anahtar.env');
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (val) out[key] = val;
  }
  return out;
}

function getConfig() {
  // Her istekte okunur: anahtar dosyası değişirse sunucuyu yeniden başlatmaya gerek kalmaz.
  const f = loadEnvFile();
  const pick = (k) => f[k] || process.env[k] || '';
  return {
    gemini: pick('GEMINI_API_KEY'),
    anthropic: pick('ANTHROPIC_API_KEY'),
    geminiModels: (pick('GEMINI_MODELS') || 'gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.8-flash')
      .split(',').map((s) => s.trim()).filter(Boolean),
    anthropicModels: (pick('ANTHROPIC_MODELS') || 'claude-sonnet-5-5,claude-haiku-5-5')
      .split(',').map((s) => s.trim()).filter(Boolean),
    geminiBase: pick('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com',
    anthropicBase: pick('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com',
  };
}

// ---------------------------------------------------------------- müfredat
function loadCurriculum() {
  const file = path.join(ROOT, 'veritabani', 'meb_mufredat.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (Array.isArray(data) && data.length) return data;
  } catch (e) {
    console.warn('[Müfredat] okunamadı:', e.message);
  }
  return [];
}

const norm = (s) => String(s || '').toLocaleLowerCase('tr-TR')
  .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
  .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
  .replace(/i̇/g, 'i').trim();

function findSubject(curr, hint) {
  const h = norm(hint);
  if (!h) return null;
  return curr.find((s) => norm(s.name) === h)
    || curr.find((s) => (s.aliases || []).some((a) => norm(a) === h))
    || curr.find((s) => h.includes(norm(s.name)))
    || curr.find((s) => (s.aliases || []).some((a) => a.length > 3 && h.includes(norm(a))))
    || null;
}

// Yapay zekanın döndürdüğü konuyu resmi listedeki en yakın başlığa oturtur.
function closestTopic(subject, predicted) {
  const topics = subject.topics;
  const p = norm(predicted);
  if (!p) return topics[0];
  const exact = topics.find((t) => norm(t) === p);
  if (exact) return exact;
  const contained = topics.find((t) => norm(t).includes(p) || p.includes(norm(t)));
  if (contained) return contained;
  const words = (s) => norm(s).split(/[\s,()\/\-–]+/).filter((w) => w.length > 2);
  const pw = words(p);
  let best = null, bestScore = 0;
  for (const t of topics) {
    const tw = words(t);
    let score = 0;
    for (const w of pw) if (tw.some((x) => x.includes(w) || w.includes(x))) score++;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best || topics[0];
}

// Yapay zeka kullanılamazsa: kitap adı / ders ipucundan basit eşleştirme.
function heuristic(curr, subjectHint, bookTitleHint) {
  const subject = findSubject(curr, subjectHint) || findSubject(curr, bookTitleHint)
    || curr.find((s) => norm(bookTitleHint).includes(norm(s.name))) || curr[0];
  const title = norm(bookTitleHint);
  let topic = null;
  if (title) {
    topic = subject.topics.find((t) => norm(t).split(/[\s,()\/]+/).filter((w) => w.length > 3).some((w) => title.includes(w)));
  }
  return { subject: subject.name, topic: topic || subject.topics[0] };
}

// ---------------------------------------------------------------- istem
function buildPrompt(curr, subjectHint, bookTitleHint) {
  const list = curr.map((s) => `DERS: ${s.name}\nKonular:\n- ${s.topics.join('\n- ')}`).join('\n\n');
  return `Sen Türkiye YKS (TYT - AYT) sınav ve MEB müfredatı uzmanısın.
Kullanıcı bir video çözümden veya soru bankasından kestiği tek bir soruyu görsel olarak gönderdi.

RESMİ DERS VE KONU LİSTESİ:
${list}

GÖREVİN:
1. Görseldeki soruyu dikkatle oku (metin, formül, şekil, grafik, tablo).
2. Sorunun DERS'ini belirle. Sadece şunlardan biri: ${curr.map((s) => s.name).join(', ')}.
3. Sorunun KONUSUNU yukarıdaki listeden, o dersin altındaki başlıklardan BİREBİR (aynı yazımla) seç. Liste dışında başlık uydurma.
   - HER ZAMAN en özel (alt) başlığı seç, genel/üst başlığı değil. Örn. elektroliz sorusu için "Elektroliz", "Elektrokimya" değil.
   - Soru birden fazla konuyu kapsıyorsa, çözümün asıl dayandığı en spesifik konuyu seç.
   - Genel/üst başlıkları (örn. "Temel Kavramlar") sadece başka hiçbir konuya girmeyen sorularda seç.
4. Görselde soru numarası varsa (köşede, "Soru 5", "12.", "[3]") sadece tam sayıyı ver; yoksa null.
5. Zorluk: 'Kolay', 'Orta', 'Zor', 'Çok Zor' veya 'ÖSYM Seviyesi'.
6. Soru kökünü tek kısa cümleyle özetle.
${subjectHint ? `\n(İPUCU: Seçili ders/kitap konusu: "${subjectHint}")` : ''}${bookTitleHint ? `\n(İPUCU: Kitap adı: "${bookTitleHint}")` : ''}

Yalnızca geçerli JSON döndür (markdown veya ek metin olmadan):
{"subject": "...", "topic": "...", "questionNumber": 8 veya null, "difficulty": "Orta", "summary": "..."}`;
}

function parseJson(text) {
  if (!text) return {};
  const t = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch (_) { /* devam */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* devam */ } }
  return {};
}

// ---------------------------------------------------------------- sağlayıcılar
class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, headers, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* düz metin */ }
    if (!res.ok) {
      const msg = (json && (json.error && (json.error.message || json.error))) || text.slice(0, 300) || res.statusText;
      throw new ApiError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('İstek zaman aşımına uğradı', 408);
    if (e instanceof ApiError) throw e;
    throw new ApiError('Ağ hatası: ' + (e.cause && e.cause.message || e.message), 0);
  } finally {
    clearTimeout(timer);
  }
}

// Geçici (tekrar denenebilir) hata mı?
const transient = (e) => e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
// Anahtar/izin hatası: diğer modelleri denemenin anlamı yok.
const fatalKey = (e) => e.status === 401 || e.status === 403 || (e.status === 400 && /api key|API_KEY/i.test(e.message));

async function withModels(models, call, label) {
  let last = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await call(model);
      } catch (e) {
        last = e;
        console.warn(`[${label}] ${model} (deneme ${attempt + 1}): ${e.status || ''} ${e.message}`);
        if (fatalKey(e)) throw e;
        if (!transient(e)) break;           // bu model olmadı (ör. 404), sonrakine geç
        await sleep(600 * (attempt + 1));
      }
    }
  }
  throw last || new Error('Model yanıt vermedi');
}

async function askGemini(cfg, curr, mime, b64, prompt) {
  const allTopics = [...new Set(curr.flatMap((s) => s.topics))];
  const schema = {
    type: 'OBJECT',
    properties: {
      subject: { type: 'STRING', enum: curr.map((s) => s.name) },
      topic: { type: 'STRING', enum: allTopics },
      questionNumber: { type: 'INTEGER', nullable: true },
      difficulty: { type: 'STRING' },
      summary: { type: 'STRING' },
    },
    required: ['subject', 'topic'],
  };
  return withModels(cfg.geminiModels, async (model) => {
    const url = `${cfg.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const json = await postJson(url, { 'x-goog-api-key': cfg.gemini }, {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: b64 } }, { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 },
    });
    const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
    const text = parts ? parts.map((p) => p.text || '').join('') : '';
    if (!text) {
      const why = (json && json.promptFeedback && json.promptFeedback.blockReason) || 'boş yanıt';
      throw new ApiError('Gemini yanıt vermedi: ' + why, 500);
    }
    return parseJson(text);
  }, 'Gemini');
}

async function askClaude(cfg, curr, mime, b64, prompt) {
  return withModels(cfg.anthropicModels, async (model) => {
    const json = await postJson(`${cfg.anthropicBase}/v1/messages`, {
      'x-api-key': cfg.anthropic, 'anthropic-version': '2023-06-01',
    }, {
      model, max_tokens: 600, temperature: 0.1,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: prompt },
      ] }],
    });
    const text = (json.content || []).map((c) => c.text || '').join('');
    if (!text) throw new ApiError('Claude boş yanıt döndürdü', 500);
    return parseJson(text);
  }, 'Claude');
}

// ---------------------------------------------------------------- analiz
async function analyze({ image, subjectHint, bookTitleHint }) {
  const curr = loadCurriculum();
  if (!curr.length) throw new ApiError('veritabani/meb_mufredat.json okunamadı', 500);

  const m = /^data:([\w.+\-\/]+);base64,(.+)$/s.exec(image);
  const mime = m ? m[1] : 'image/png';
  const b64 = m ? m[2] : image;

  const cfg = getConfig();
  const providers = [];
  if (cfg.gemini) providers.push(['Gemini', askGemini]);
  if (cfg.anthropic) providers.push(['Claude', askClaude]);

  const fallback = (note) => {
    const h = heuristic(curr, subjectHint, bookTitleHint);
    return { subject: h.subject, topic: h.topic, questionNumber: null, difficulty: 'Orta', summary: note, ai: false };
  };

  if (!providers.length) {
    return fallback('API anahtarı yok: anahtar.env dosyasına GEMINI_API_KEY ekleyin. Konu müfredattan tahmin edildi.');
  }

  const prompt = buildPrompt(curr, subjectHint, bookTitleHint);
  const errors = [];
  for (const [name, fn] of providers) {
    try {
      const r = await fn(cfg, curr, mime, b64, prompt);
      const subject = findSubject(curr, r.subject) || findSubject(curr, subjectHint) || curr[0];
      const topic = closestTopic(subject, r.topic);
      const qn = Number.parseInt(r.questionNumber, 10);
      return {
        subject: subject.name,
        topic,
        questionNumber: Number.isFinite(qn) && qn > 0 ? qn : null,
        difficulty: r.difficulty || 'Orta',
        summary: r.summary || '',
        ai: true,
        provider: name,
      };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      console.warn(`[${name}] başarısız:`, e.message);
    }
  }
  return fallback('Yapay zeka kullanılamadı (' + errors.join(' | ').slice(0, 200) + '). Konu müfredattan tahmin edildi.');
}


// ---------------------------------------------------------------- OCR kurulumu (ilk açılışta bir kez)
// Tesseract (metin okuma) dosyaları npm paketlerinden indirilip ocr/ klasörüne konur.
// Sonrasında tamamen çevrimdışı çalışır.
const OCR_DIR = path.join(ROOT, 'ocr');
const OCR_FILES = [
  ['tesseract.min.js', 'tesseract.js@5.1.1/dist/tesseract.min.js'],
  ['worker.min.js', 'tesseract.js@5.1.1/dist/worker.min.js'],
  ['core/tesseract-core-simd-lstm.wasm.js', 'tesseract.js-core@5.1.1/tesseract-core-simd-lstm.wasm.js'],
  ['core/tesseract-core-lstm.wasm.js', 'tesseract.js-core@5.1.1/tesseract-core-lstm.wasm.js'],
  ['core/tesseract-core-simd.wasm.js', 'tesseract.js-core@5.1.1/tesseract-core-simd.wasm.js'],
  ['core/tesseract-core.wasm.js', 'tesseract.js-core@5.1.1/tesseract-core.wasm.js'],
  ['lang/tur.traineddata.gz', '@tesseract.js-data/tur@1.0.0/4.0.0_best_int/tur.traineddata.gz'],
];
const OCR_MIRRORS = (process.env.SORU_OCR_BASE ? [process.env.SORU_OCR_BASE] : [
  'https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/', 'https://fastly.jsdelivr.net/npm/',
]);
let ocrBusy = false;

function ocrReady() {
  return OCR_FILES.every(([dest]) => { try { return fs.statSync(path.join(OCR_DIR, dest)).size > 1000; } catch (_) { return false; } });
}

async function downloadTo(dest, spec) {
  let lastErr = null;
  for (const base of OCR_MIRRORS) {
    try {
      const res = await fetch(base.replace(/\/?$/, '/') + spec, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) throw new Error('dosya çok küçük');
      const full = path.join(OCR_DIR, dest);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full + '.part', buf);
      fs.renameSync(full + '.part', full);
      return buf.length;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('indirilemedi');
}

async function installOcr() {
  if (ocrBusy || ocrReady()) return;
  ocrBusy = true;
  console.log('  Soru okuyucu (OCR) dosyaları indiriliyor, ilk açılışta bir kez (~20 MB)...');
  try {
    for (const [dest, spec] of OCR_FILES) {
      if (fs.existsSync(path.join(OCR_DIR, dest)) && fs.statSync(path.join(OCR_DIR, dest)).size > 1000) continue;
      const n = await downloadTo(dest, spec);
      console.log('    + ' + dest + ' (' + Math.round(n / 1024) + ' KB)');
    }
    console.log('  Soru okuyucu hazır. Artık internet olmadan da çalışır.');
  } catch (e) {
    console.warn('  [UYARI] Soru okuyucu indirilemedi: ' + e.message);
    console.warn('          İnternete bağlıyken uygulamayı yeniden başlatın. Bu arada uygulama internetten yüklemeyi dener.');
  } finally { ocrBusy = false; }
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
// Dışarıya asla verilmeyecek dosyalar (API anahtarı vb.)
const BLOCKED = /^(anahtar[^/]*|sunucu\.js|eslesme_sunucu\.js|eslesme\.json|server\.cjs|sunucu\.ps1|baslat\.(bat|sh))$/i;

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError('Görsel çok büyük (30MB sınırı)', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath).replace(/^\/+/, ''); } catch (_) { return send(res, 400, 'Geçersiz adres', 'text/plain'); }
  if (!rel) rel = 'index.html';
  const full = path.resolve(ROOT, rel);
  const inside = full === ROOT || full.startsWith(ROOT + path.sep);
  const blocked = BLOCKED.test(path.basename(full)) || /^veritabani[\\/]senkron([\\/]|$)/i.test(path.relative(ROOT, full)) || path.relative(ROOT, full).split(path.sep).some((p) => p.startsWith('.'));
  let file = null;
  if (inside && !blocked) {
    try { if (fs.statSync(full).isFile()) file = full; } catch (_) { /* yok */ }
  }
  if (!file) {
    if (path.extname(rel)) return send(res, 404, 'Bulunamadı', 'text/plain; charset=utf-8');
    file = path.join(ROOT, 'index.html');          // SPA yönlendirmesi
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const noCache = /sw\.js$|index\.html$/.test(file) ? { 'Cache-Control': 'no-cache' } : {};
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 500, 'Dosya okunamadı', 'text/plain; charset=utf-8');
    send(res, 200, data, type, noCache);
  });
}

let mainPort = 0;
const esl = require('./eslesme_sunucu.js')({ ROOT, send, readBody, getMainPort: () => mainPort });

// lan=true: tablet için açılan yerel ağ dinleyicisinden gelen istek (eşleşme gerektirir)
async function handle(req, res, lan) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (await esl.route(req, res, url, lan)) return;
    if (url.pathname === '/api/health') {
      const cfg = getConfig();
      return send(res, 200, { status: 'ok', gemini: !!cfg.gemini, claude: !!cfg.anthropic, ocr: ocrReady(), ocrInstalling: ocrBusy });
    }
    if (url.pathname === '/api/ai-analyze' || url.pathname === '/api/analyze-question') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST gerekli' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) {
        return send(res, e.status || 400, { error: e.status ? e.message : 'Geçersiz JSON' });
      }
      if (!body || typeof body.image !== 'string' || !body.image) {
        return send(res, 400, { error: 'Resim verisi eksik veya geçersiz.' });
      }
      return send(res, 200, await analyze(body));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Yöntem desteklenmiyor', 'text/plain');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('İstek hatası:', e);
    send(res, 500, { error: e.message || 'Sunucu hatası' });
  }
}
const server = http.createServer((req, res) => handle(req, res, false));

function openBrowser(url) {
  if (process.env.SORU_NO_BROWSER) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* tarayıcı açılamazsa adres zaten yazdırıldı */ });
}

function listen(i) {
  if (i >= PORTS.length) {
    console.error('[HATA] 5500, 5501, 5502, 5503 ve 8080 portları dolu. Açık başka pencereleri kapatıp tekrar deneyin.');
    process.exit(1);
  }
  const port = Number(process.env.PORT) || PORTS[i];
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && !process.env.PORT) return listen(i + 1);
    console.error('[HATA] Sunucu başlatılamadı:', e.message);
    process.exit(1);
  });
  // Sadece bu bilgisayardan erişilir (API anahtarı ağa açılmasın).
  server.listen(port, '127.0.0.1', () => {
    mainPort = port;
    esl.init((rq, rs) => handle(rq, rs, true));
    const url = `http://127.0.0.1:${port}/`;
    const cfg = getConfig();
    console.log('================================================================');
    console.log('  Soru Ekleme çalışıyor ->', url);
    console.log('  Yapay zeka (istege bagli yedek):',
      cfg.gemini && cfg.anthropic ? 'Gemini + Claude hazır'
        : cfg.gemini ? 'Gemini hazır' : cfg.anthropic ? 'Claude hazır'
          : 'yok (gerekmez, konu tespiti cihazda yapılır)');
    console.log('  Soru okuyucu (OCR):', ocrReady() ? 'hazır (çevrimdışı)' : 'kurulacak');
    console.log('  Bu pencereyi uygulama açıkken kapatmayın.');
    console.log('================================================================');
    openBrowser(url);
    installOcr();
  });
}

if (require.main === module) listen(0);
module.exports = { analyze, closestTopic, heuristic, server };
