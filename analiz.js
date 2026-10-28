// Soru metninden ders + konu tespiti (kural tabanlı, tamamen çevrimdışı).
// Tarayıcıda window.SoruAnaliz, Node'da module.exports olarak kullanılır.
(function (root) {
  'use strict';
  function fold(s) {
    return String(s || '').replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase()
      .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
      .replace(/ö/g, 'o').replace(/ç/g, 'c').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[‘’′]/g, "'").replace(/[−–—]/g, '-').replace(/\s+/g, ' ');
  }
  var isAl = function (c) { return /[a-z0-9]/.test(c); };

  function compile(data) {
    var subjects = data.subjects.map(function (s) {
      return {
        name: s.name, aliases: s.aliases.map(fold),
        topics: s.topics.map(function (t) {
          return { name: t.name, kws: t.kw.map(function (k) {
            var i = k.lastIndexOf(':'), w = parseFloat(k.slice(i + 1));
            var kw = fold(k.slice(0, i)).trim();
            var alnum = /^[a-z0-9 ]+$/.test(kw);
            return { kw: kw, w: w, whole: alnum && kw.replace(/ /g, '').length <= 3, wordStart: isAl(kw[0] || '') };
          }).filter(function (x) { return x.kw && x.w > 0; }) };
        })
      };
    });
    return { subjects: subjects };
  }

  function countHits(text, k) {
    var n = 0, from = 0, i, kw = k.kw, L = kw.length;
    while ((i = text.indexOf(kw, from)) >= 0) {
      from = i + L;
      if (k.wordStart && i > 0 && isAl(text[i - 1])) continue;
      if (k.whole && L + i < text.length && isAl(text[i + L])) continue;
      n++; if (n >= 3) break;
    }
    return n;
  }

  function findSubject(model, hint) {
    var h = fold(hint).trim(); if (!h) return null;
    var S = model.subjects, i, j;
    for (i = 0; i < S.length; i++) if (fold(S[i].name) === h) return S[i];
    for (i = 0; i < S.length; i++) for (j = 0; j < S[i].aliases.length; j++) if (S[i].aliases[j] === h) return S[i];
    for (i = 0; i < S.length; i++) if (h.indexOf(fold(S[i].name)) >= 0) return S[i];
    for (i = 0; i < S.length; i++) for (j = 0; j < S[i].aliases.length; j++) if (S[i].aliases[j].length > 3 && h.indexOf(S[i].aliases[j]) >= 0) return S[i];
    return null;
  }

  // text: OCR çıktısı. opts: {subjectHint, bookTitleHint, subjectLocked}
  function classify(model, text, opts) {
    opts = opts || {};
    var t = fold(text);
    var hinted = findSubject(model, opts.subjectHint) || findSubject(model, opts.bookTitleHint);
    var rows = [];
    model.subjects.forEach(function (s) {
      var boost = hinted && hinted === s ? (opts.subjectLocked ? 1.6 : 1.25) : 1;
      s.topics.forEach(function (tp) {
        var score = 0, hits = [];
        tp.kws.forEach(function (k) {
          var n = countHits(t, k);
          if (n) { score += k.w * (1 + 0.4 * (n - 1)); hits.push([k.kw, k.w]); }
        });
        if (score > 0) rows.push({ subject: s, topic: tp.name, score: score * boost, raw: score, hits: hits });
      });
    });
    rows.sort(function (a, b) { return b.score - a.score; });
    var top = rows[0], second = rows[1];
    if (!top) return { subject: hinted ? hinted.name : null, topic: null, confidence: 0, matched: [], alternatives: [], textLength: t.length };
    var sameSubj = rows.filter(function (r) { return r.subject === top.subject; });
    var runner = sameSubj[1] ? sameSubj[1].score : 0;
    var conf = Math.min(1, (top.score / (top.score + runner + 4)) * Math.min(1, top.raw / 8));
    top.hits.sort(function (a, b) { return b[1] - a[1]; });
    return {
      subject: top.subject.name, topic: top.topic, confidence: conf, score: top.raw,
      matched: top.hits.slice(0, 4).map(function (h) { return h[0]; }),
      alternatives: rows.slice(1, 4).map(function (r) { return r.subject.name + ' / ' + r.topic; }),
      textLength: t.length
    };
  }

  // Sorudaki numarayı bulmaya çalışır ("Soru 5", "12.", "5)" satır başında).
  function findQuestionNumber(text) {
    var m = /(?:^|\n)\s*(?:soru\s*)?(\d{1,3})\s*[.)\]]/i.exec(String(text || ''));
    if (!m) m = /soru\s*(?:no|numarasi|numarası)?\s*[:\-]?\s*(\d{1,3})/i.exec(String(text || ''));
    var n = m ? parseInt(m[1], 10) : null;
    return n && n > 0 && n <= 200 ? n : null;
  }

  var api = { fold: fold, compile: compile, classify: classify, findSubject: findSubject, findQuestionNumber: findQuestionNumber };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SoruAnaliz = api;
})(typeof window !== 'undefined' ? window : this);
