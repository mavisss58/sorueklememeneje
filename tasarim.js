// Soru Ekleme — açık/koyu tema. Düğme üst çubukta (React tarafından çizilir); seçim hatırlanır.
(function () {
  'use strict';
  var KEY = 'soru_ekleme_tema';
  function oku() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function yaz(v) { try { localStorage.setItem(KEY, v); } catch (_) {} }
  function uygula(koyu) {
    document.documentElement.classList.toggle('dark', koyu);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', koyu ? '#070d1f' : '#1b2f5c');
  }
  var k = oku();
  uygula(k ? k === 'koyu' : !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches));
  window.__tema = function () {
    var koyu = !document.documentElement.classList.contains('dark');
    uygula(koyu); yaz(koyu ? 'koyu' : 'acik');
  };
})();
