// Soru Ekleme - gömülü soru okuyucu.
// Uygulamanın /api/analyze-question isteğini yakalar ve soruyu bu cihazda çözer:
//   1) Görselden OCR ile metin okunur (Tesseract, çevrimdışı)
//   2) Metin, kısa ve özel konu listesine göre sınıflandırılır (analiz.js)
//   3) Sonuç zayıfsa ve yapay zekâ hazırsa (Claude/Gemini) ona sorulur; yoksa yerel sonuç kullanılır
(function () {
  'use strict';
  var realFetch = window.fetch.bind(window);
  var model = null, rawCurr = null;

  function J(obj) {
    return new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  function log() { try { console.info.apply(console, ['[Soru Okuyucu]'].concat([].slice.call(arguments))); } catch (_) {} }

  async function loadModel() {
    if (model) return model;
    var r = await realFetch('veritabani/konular.json');
    var data = await r.json();
    rawCurr = data;
    model = window.SoruAnaliz.compile(data);
    return model;
  }

  // ------------------------------------------------------------------ OCR
  var ocrState = null;      // {worker} | {error}
  var ocrPromise = null;

  async function exists(url) {
    try { var r = await realFetch(url, { method: 'HEAD' }); return r.ok; } catch (_) { return false; }
  }
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = function () { rej(new Error('yüklenemedi: ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function getWorker() {
    if (ocrState && ocrState.worker) return ocrState.worker;
    if (ocrState && ocrState.error) throw ocrState.error;
    if (!ocrPromise) ocrPromise = (async function () {
      var inViewer = !!window.claude;                       // yayımlanan önizleme: harici ağ kapalı
      var local = await exists('ocr/tesseract.min.js') && await exists('ocr/lang/tur.traineddata.gz');
      var opts;
      if (local) {
        if (!window.Tesseract) await loadScript('ocr/tesseract.min.js');
        opts = { workerPath: 'ocr/worker.min.js', corePath: 'ocr/core/', langPath: 'ocr/lang/', gzip: true };
      } else if (!inViewer) {
        var cdn = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/';
        if (!window.Tesseract) await loadScript(cdn + 'tesseract.min.js');
        opts = {};        // kütüphane kendi CDN adreslerini kullanır (internet gerekir, sonra önbellekte kalır)
      } else {
        throw new Error('OCR dosyaları bu görünümde yok');
      }
      if (!window.Tesseract) throw new Error('Tesseract yüklenemedi');
      var w = await window.Tesseract.createWorker('tur', 1, opts);
      return w;
    })();
    try {
      var w = await ocrPromise;
      ocrState = { worker: w };
      return w;
    } catch (e) {
      ocrState = { error: e };
      throw e;
    }
  }

  function dataUrlToImage(u) {
    return new Promise(function (res, rej) {
      var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { rej(new Error('görsel açılamadı')); }; im.src = u;
    });
  }
  // Küçük/soluk ekran görüntülerini OCR için büyütür ve griye çevirir.
  async function prepare(dataUrl) {
    var im = await dataUrlToImage(dataUrl);
    var scale = 1;
    if (im.width < 1400) scale = Math.min(3, 1400 / im.width);
    if (im.width * scale > 3200) scale = 3200 / im.width;
    var c = document.createElement('canvas');
    c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(im, 0, 0, c.width, c.height);
    var d = g.getImageData(0, 0, c.width, c.height), p = d.data;
    for (var i = 0; i < p.length; i += 4) {
      var y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      y = y < 128 ? Math.max(0, y - 25) : Math.min(255, y + 25);   // hafif kontrast
      p[i] = p[i + 1] = p[i + 2] = y;
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  async function ocr(dataUrl) {
    var w = await getWorker();
    var canvas = await prepare(dataUrl);
    var r = await w.recognize(canvas);
    return (r && r.data && r.data.text) || '';
  }

  // ------------------------------------------------------------------ AI (yedek)
  function aiPrompt(hint, book) {
    var list = rawCurr.subjects.map(function (s) { return 'DERS: ' + s.name + '\nKonular: ' + s.topics.map(function (t) { return t.name; }).join(' | '); }).join('\n\n');
    return 'Sen Türkiye YKS (TYT/AYT) uzmanısın. Ekteki görsel TEK bir sorudur.\n\n' + list +
      '\n\nGÖREV: Sorunun dersini ve konusunu yukarıdaki listeden BİREBİR seç. Her zaman en özel (alt) başlığı seç, genel başlığı değil ' +
      '(örn. elektroliz sorusu için "Elektroliz", "Elektrokimya" değil). Listede olmayan başlık uydurma.' +
      (hint ? '\n(İpucu: ' + hint + ')' : '') + (book ? '\n(Kitap: ' + book + ')' : '') +
      '\nSoru numarası görünüyorsa tam sayı ver, yoksa null. Zorluk: Kolay, Orta, Zor, Çok Zor veya ÖSYM Seviyesi.' +
      '\nYalnızca JSON: {"subject":"...","topic":"...","questionNumber":null,"difficulty":"Orta","summary":"tek kısa cümle"}';
  }
  function dataUrlToBlob(u) {
    var m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(u);
    var bin = atob(m[3]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] || 'image/png' });
  }
  async function askAI(body) {
    var prompt = aiPrompt(body.subjectHint, body.bookTitleHint), r = null;
    if (window.claude) {                                           // yayımlanan önizleme: Claude
      var sample = await window.claude.use('sample');
      if (sample) {
        var lim = await sample.limits().catch(function () { return null; });
        if (lim && lim.images) r = await sample.json(prompt, { images: [dataUrlToBlob(body.image)], modelTier: 'default', cache: false });
      }
    }
    if (!r) {                                                      // bilgisayar sürümü: sunucudaki Gemini/Claude anahtarı
      var h = await realFetch('/api/health').then(function (x) { return x.ok ? x.json() : null; }).catch(function () { return null; });
      if (h && (h.gemini || h.claude)) {
        var resp = await realFetch('/api/ai-analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var j = await resp.json();
        if (j && j.ai) r = j;
      }
    }
    return r;
  }

  // ------------------------------------------------------------------ ana akış
  async function analyze(body) {
    var A = window.SoruAnaliz;
    var m = await loadModel();
    var hinted = A.findSubject(m, body.subjectHint) || A.findSubject(m, body.bookTitleHint);
    var opts = { subjectHint: body.subjectHint, bookTitleHint: body.bookTitleHint };
    var text = '', ocrErr = null, local = null;

    try { text = await ocr(body.image); } catch (e) { ocrErr = e; log('OCR kullanılamadı:', e && e.message || e); }
    if (text && text.trim().length > 8) local = A.classify(m, text, opts);

    var weak = !local || !local.topic || local.confidence < 0.35;
    if (weak) {
      try {
        var ai = await askAI(body);
        if (ai && ai.topic) {
          var subj = A.findSubject(m, ai.subject) || hinted || m.subjects[0];
          var names = subj.topics.map(function (t) { return t.name; });
          var topic = names.indexOf(ai.topic) >= 0 ? ai.topic : null;
          if (!topic) { var low = A.fold(ai.topic); topic = subj.topics.map(function (t) { return t.name; }).find(function (n) { return A.fold(n) === low; }) || (local && local.topic) || ai.topic; }
          var qn = parseInt(ai.questionNumber, 10);
          return J({ subject: subj.name, topic: topic, questionNumber: isFinite(qn) && qn > 0 ? qn : (text ? A.findQuestionNumber(text) : null),
            difficulty: ai.difficulty || 'Orta', summary: ai.summary || 'Yapay zeka ile belirlendi.' });
        }
      } catch (e) { log('AI yedeği başarısız:', e && (e.code || e.message) || e); }
    }

    if (local && local.topic) {
      var shown = text.replace(/\s+/g, ' ').trim().slice(0, 70);
      var pct = Math.round(local.confidence * 100);
      return J({
        subject: local.subject, topic: local.topic, questionNumber: A.findQuestionNumber(text), difficulty: 'Orta',
        summary: 'Cihazda okundu (%' + pct + ' güven). Eşleşen: ' + local.matched.join(', ') +
          (local.alternatives.length && local.confidence < 0.6 ? '. Olası: ' + local.alternatives.slice(0, 2).join('; ') : '')
      });
    }
    var fb = hinted || m.subjects[0];
    var why = ocrErr ? 'OCR hazır değil (' + (ocrErr.message || ocrErr) + ')' : (text && text.trim().length > 8 ? 'Metinde konu bulunamadı' : 'Görselde okunabilir metin bulunamadı');
    return J({ subject: fb.name, topic: fb.topics[0].name, questionNumber: null, difficulty: 'Orta', summary: why + '. Konuyu elle seçin.' });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/\/api\/analyze-question$/.test(url.split('?')[0])) return realFetch(input, init);
    var body; try { body = JSON.parse(init && init.body); } catch (_) { return Promise.resolve(J({ error: 'bad request' })); }
    return analyze(body).catch(function (e) {
      log('analiz hatası', e); return J({ subject: body.subjectHint || 'Matematik', topic: '', questionNumber: null, difficulty: 'Orta', summary: 'Okuyucu hatası: ' + (e && e.message || e) });
    });
  };
})();
