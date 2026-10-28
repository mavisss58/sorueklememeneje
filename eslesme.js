// Soru Ekleme — tablet eşleme ve eşitleme (arayüz + istemci).
// 1) IndexedDB yazma/silme işlemlerini izler (hangi kayıt ne zaman değişti)
// 2) Ayarlar penceresine "Tablet Eşleme" sekmesi ekler
// 3) Bilgisayardaki sunucu (eşitleme merkezi) ile iki yönlü eşitler
// Kaldırmak için index.html'deki eslesme.js / qr.js / eslesme.css satırlarını silin.
(function () {
  'use strict';
  var DB = 'soru_arsiv_db', META = 'eslesme_meta_v1', PREF = 'eslesme_oto';
  var HDR = { 'Content-Type': 'application/json', 'X-Soru-Istek': '1' };
  var TIP = { questions: 'q:', books: 'b:' };

  // ------------------------------------------------------------ yerel kayıt zamanları
  var meta = (function () { try { var m = JSON.parse(localStorage.getItem(META)); if (m && m.mod) return m; } catch (_) {} return { mod: {}, del: {}, off: 0, last: 0 }; })();
  var saveT = null;
  function saveMeta() { clearTimeout(saveT); saveT = setTimeout(function () { try { localStorage.setItem(META, JSON.stringify(meta)); } catch (_) {} }, 300); }
  function now() { return Date.now() + (meta.off || 0); }
  var applying = false, dirtyHook = null;

  function track(store, op, a) {
    if (applying) return;
    try {
      if (!store.transaction || store.transaction.db.name !== DB || !TIP[store.name]) return;
      var key = null;
      if (op === 'put') key = a && a.id != null ? TIP[store.name] + a.id : null;
      else key = typeof a === 'string' || typeof a === 'number' ? TIP[store.name] + a : null;
      if (!key) return;
      if (op === 'put') { meta.mod[key] = now(); delete meta.del[key]; } else { meta.del[key] = now(); delete meta.mod[key]; }
      saveMeta(); if (dirtyHook) dirtyHook();
    } catch (_) {}
  }
  (function () {
    var P = window.IDBObjectStore && IDBObjectStore.prototype; if (!P) return;
    ['put', 'add'].forEach(function (n) { var o = P[n]; P[n] = function (v) { track(this, 'put', v); return o.apply(this, arguments); }; });
    var d = P.delete; P.delete = function (k) { track(this, 'del', k); return d.apply(this, arguments); };
  })();

  // ------------------------------------------------------------ IndexedDB yardımcıları
  function openDb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB);
      r.onupgradeneeded = function () { r.transaction.abort(); };       // henüz oluşmamışsa yaratma
      r.onsuccess = function () { r.result.objectStoreNames.contains('questions') ? res(r.result) : (r.result.close(), rej(new Error('Veritabanı hazır değil'))); };
      r.onerror = function () { rej(r.error || new Error('Veritabanı açılamadı')); };
    });
  }
  function rq(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function txDone(t) { return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('iptal')); }; }); }

  async function localManifest(db) {
    var items = {}, store, keys, i, k;
    for (var name in TIP) {
      store = db.transaction(name, 'readonly').objectStore(name);
      keys = await rq(store.getAllKeys());
      for (i = 0; i < keys.length; i++) {
        k = TIP[name] + keys[i];
        if (meta.mod[k] == null) {                                // izlenmemiş (eski) kayıt: oluşturma zamanı
          var rec = await rq(db.transaction(name, 'readonly').objectStore(name).get(keys[i]));
          meta.mod[k] = name === 'questions' ? (Number(rec && rec.createdAt) || 1) : 1;
        }
        items[k] = [meta.mod[k], 0];
      }
    }
    Object.keys(meta.del).forEach(function (k) { if (!items[k]) items[k] = [meta.del[k], 1]; });
    saveMeta();
    return items;
  }
  async function readRecord(db, key) {
    var name = key[0] === 'q' ? 'questions' : 'books';
    return rq(db.transaction(name, 'readonly').objectStore(name).get(key.slice(2)));
  }

  // ------------------------------------------------------------ eşitleme
  function api(path, body) {
    return fetch(path, body === undefined ? { headers: HDR, cache: 'no-store' } : { method: 'POST', headers: HDR, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || ('Hata ' + r.status)); return j; }); });
  }
  var busy = false, st = { last: meta.last || 0, msg: '', err: '', changed: 0 };
  var listeners = [];
  function emit() { listeners.forEach(function (f) { try { f(); } catch (_) {} }); }

  function chunks(arr, size) { var o = []; for (var i = 0; i < arr.length; i += size) o.push(arr.slice(i, i + size)); return o; }

  async function sync(manual) {
    if (busy) return;
    busy = true; st.err = ''; st.msg = 'Eşitleniyor…'; emit();
    var db = null, got = 0, sent = 0;
    try {
      db = await openDb();
      var items = await localManifest(db);
      var plan = await api('/api/sync/manifest', { items: items });
      meta.off = (plan.now || Date.now()) - Date.now();

      // 1) bu cihazdan merkeze
      var batch = [], size = 0, rec, i, k;
      async function flush() { if (batch.length) { await api('/api/sync/push', { records: batch }); sent += batch.length; batch = []; size = 0; } }
      for (i = 0; i < plan.want.length; i++) {
        k = plan.want[i];
        if (items[k] && items[k][1]) { batch.push({ key: k, ts: items[k][0], del: true }); continue; }
        rec = await readRecord(db, k);
        if (!rec) continue;
        var n = JSON.stringify(rec).length;
        if (size + n > 4e6) await flush();
        batch.push({ key: k, ts: items[k][0], data: rec }); size += n;
      }
      await flush();

      // 2) merkezden bu cihaza
      var pull = plan.send || [], tsOf = {};
      pull.forEach(function (x) { tsOf[x.key] = x; });
      var parts = chunks(pull.map(function (x) { return x.key; }), 12);
      for (var p = 0; p < parts.length; p++) {
        var r = await api('/api/sync/pull', { keys: parts[p] });
        applying = true;
        try {
          var names = ['questions', 'books'], t = db.transaction(names, 'readwrite'), done = txDone(t);
          (r.records || []).forEach(function (x) {
            var s = t.objectStore(x.key[0] === 'q' ? 'questions' : 'books');
            if (x.del) { s.delete(x.key.slice(2)); meta.del[x.key] = x.ts; delete meta.mod[x.key]; }
            else { s.put(x.data); meta.mod[x.key] = x.ts; delete meta.del[x.key]; }
            got++;
          });
          await done;
        } finally { applying = false; }
      }
      meta.last = Date.now(); st.last = meta.last; saveMeta();
      st.msg = (got || sent) ? ('Eşitlendi: ' + sent + ' gönderildi, ' + got + ' alındı') : 'Her şey güncel';
      if (got) { st.changed += got; showToast(); }
    } catch (e) {
      st.err = (e && e.message) || 'Eşitleme başarısız'; st.msg = '';
      if (manual === false) st.err = '';           // otomatik denemede sessiz kal
    } finally {
      if (db) db.close();
      busy = false; emit();
    }
  }

  // ------------------------------------------------------------ otomatik eşitleme
  var role = null, durum = null, timer = null, deb = null;
  function autoOn() { try { return localStorage.getItem(PREF) !== '0'; } catch (_) { return true; } }
  function enabled() { return role === 'tablet' || (role === 'pc' && durum && durum.devices && durum.devices.length > 0); }
  function schedule() { clearTimeout(deb); if (!enabled() || !autoOn()) return; deb = setTimeout(function () { sync(false); }, 4000); }
  dirtyHook = schedule;

  async function refreshDurum() {
    try { durum = await api('/api/eslesme/durum'); role = durum.role; }
    catch (_) { durum = null; role = null; }
    return durum;
  }
  async function boot() {
    await refreshDurum();
    if (enabled() && autoOn()) setTimeout(function () { sync(false); }, 1500);
    timer = setInterval(async function () {
      if (document.hidden) return;
      await refreshDurum();
      if (enabled() && autoOn()) sync(false);
    }, 45000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && enabled() && autoOn()) sync(false); });
  }

  // ------------------------------------------------------------ "yeni veri geldi" bildirimi
  function showToast() {
    if (document.getElementById('se-toast')) { document.getElementById('se-toast-t').textContent = st.changed + ' kayıt güncellendi'; return; }
    var d = document.createElement('div'); d.id = 'se-toast'; d.className = 'se-toast';
    d.innerHTML = '<span id="se-toast-t"></span><button type="button" class="se-btn se-btn-sm">Yenile</button><button type="button" class="se-x" aria-label="Kapat">×</button>';
    d.querySelector('#se-toast-t').textContent = st.changed + ' kayıt güncellendi (eşitleme)';
    d.querySelector('.se-btn').onclick = function () { location.reload(); };
    d.querySelector('.se-x').onclick = function () { d.remove(); };
    document.body.appendChild(d);
  }

  // ------------------------------------------------------------ ayarlar sekmesi
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(ts) { if (!ts) return 'henüz yok'; var d = new Date(ts); return d.toLocaleDateString('tr-TR') + ' ' + d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }); }

  var panels = [];
  function buildPanel() {
    var box = el('div', 'se-panel'), pair = null, poll = null, tick = null, alive = true;

    function render() {
      if (!alive) return;
      var h = '';
      if (!durum) {
        h = '<div class="se-card se-warn"><b>Eşleme kullanılamıyor.</b><p>Uygulama sunucu olmadan açılmış. Eşleme için klasördeki <b>BASLAT.bat</b> (Mac/Linux: BASLAT.sh) ile açın.</p></div>';
        box.innerHTML = h; return;
      }
      h += '<div class="se-intro"><b>Tablet ile eşitle</b><p>Bilgisayarınızdaki sorular ve kitaplar, aynı Wi-Fi ağındaki tabletinizle iki yönlü eşitlenir. Veriler internete çıkmaz; yalnızca kendi ağınızda dolaşır.</p></div>';
      if (role === 'pc') {
        if (pair) {
          h += '<div class="se-card se-pair"><div class="se-qr" id="se-qr"></div><div class="se-pairtxt">' +
            '<div class="se-lbl">Tabletten QR kodu okutun</div>' +
            '<div class="se-lbl se-sm">veya tarayıcıya adresi yazıp bu kodu girin:</div>' +
            '<div class="se-code" id="se-code">' + esc(pair.code.slice(0, 3) + ' ' + pair.code.slice(3)) + '</div>' +
            '<div class="se-url">' + pair.ips.map(esc).join('<br>') + '</div>' +
            '<div class="se-lbl se-sm">Kod <b id="se-left"></b> içinde geçerli ve <b>tek kullanımlık</b>tır.</div>' +
            '<button type="button" class="se-btn se-btn-ghost" id="se-cancel">İptal</button></div></div>';
        } else {
          h += '<div class="se-card"><button type="button" class="se-btn" id="se-start">Yeni tablet eşle</button>' +
            (st.pairErr ? '<p class="se-err">' + esc(st.pairErr) + '</p>' : '') +
            '<p class="se-sm">Tablet ve bilgisayar aynı Wi-Fi ağında olmalı. İlk seferde Windows güvenlik duvarı izin sorarsa <b>İzin ver</b> deyin.</p></div>';
        }
        h += '<div class="se-card"><div class="se-row"><b>Eşleşmiş cihazlar</b></div>';
        var dv = durum.devices || [];
        h += dv.length ? dv.map(function (d) {
          return '<div class="se-dev"><div><b>' + esc(d.name) + '</b><div class="se-sm">Eşleşme: ' + fmt(d.createdAt) + ' · Son görülme: ' + fmt(d.lastSeen) + '</div></div>' +
            '<button type="button" class="se-btn se-btn-ghost se-btn-sm" data-del="' + esc(d.id) + '">Kaldır</button></div>';
        }).join('') : '<p class="se-sm">Henüz eşleşmiş cihaz yok.</p>';
        h += '</div>';
      } else {
        h += '<div class="se-card"><b>Bu cihaz bilgisayarla eşleşmiş</b><p class="se-sm">' + esc((durum.device && durum.device.name) || '') + '</p>' +
          '<button type="button" class="se-btn se-btn-ghost se-btn-sm" id="se-unpair">Eşlemeyi bu cihazdan kaldır</button></div>';
      }
      h += '<div class="se-card"><div class="se-row"><b>Eşitleme</b><span class="se-sm">Son: ' + fmt(st.last) + '</span></div>' +
        '<div class="se-row"><button type="button" class="se-btn" id="se-sync"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Eşitleniyor…' : 'Şimdi eşitle') + '</button>' +
        '<label class="se-chk"><input type="checkbox" id="se-auto"' + (autoOn() ? ' checked' : '') + '> Otomatik eşitle</label></div>' +
        (st.msg && !busy ? '<p class="se-ok">' + esc(st.msg) + '</p>' : '') + (st.err ? '<p class="se-err">' + esc(st.err) + '</p>' : '') +
        (st.changed ? '<p class="se-sm">Yeni gelen kayıtları görmek için <a href="#" id="se-reload">sayfayı yenileyin</a>.</p>' : '') + '</div>';
      box.innerHTML = h;

      var q = function (s) { return box.querySelector(s); };
      if (pair && q('#se-qr')) { try { q('#se-qr').innerHTML = window.SoruQR.svg(pair.url, {}); } catch (e) { q('#se-qr').textContent = 'QR üretilemedi'; } }
      if (q('#se-start')) q('#se-start').onclick = startPair;
      if (q('#se-cancel')) q('#se-cancel').onclick = cancelPair;
      if (q('#se-sync')) q('#se-sync').onclick = function () { sync(true).then(function () { if (st.changed) setTimeout(function () { location.reload(); }, 900); }); };
      if (q('#se-auto')) q('#se-auto').onchange = function (e) { try { localStorage.setItem(PREF, e.target.checked ? '1' : '0'); } catch (_) {} schedule(); };
      if (q('#se-reload')) q('#se-reload').onclick = function (e) { e.preventDefault(); location.reload(); };
      if (q('#se-unpair')) q('#se-unpair').onclick = function () {
        if (!confirm('Bu tablet bilgisayarla eşitlenmeyi bırakacak. Tabletteki sorular silinmez. Devam edilsin mi?')) return;
        api('/api/eslesme/kaldir-ben', {}).then(function () { location.reload(); }).catch(function (e) { st.err = e.message; render(); });
      };
      box.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Bu cihazın eşleşmesi kaldırılsın mı? Tekrar eşlemek için yeni QR gerekir.')) return;
          api('/api/eslesme/kaldir', { id: b.getAttribute('data-del') }).then(refreshDurum).then(render);
        };
      });
      tickLeft();
    }

    function tickLeft() {
      var l = box.querySelector('#se-left'); if (!l || !pair) return;
      var s = Math.max(0, Math.round((pair.expiresAt - pair.skewNow()) / 1000));
      l.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    async function startPair() {
      st.pairErr = '';
      try {
        var r = await api('/api/eslesme/baslat', {});
        if (r.error) { st.pairErr = r.error; render(); return; }
        var off = r.now - Date.now();
        pair = { code: r.code, url: r.url, ips: r.ips, expiresAt: r.expiresAt, skewNow: function () { return Date.now() + off; } };
        var before = (durum.devices || []).length;
        render();
        clearInterval(poll); clearInterval(tick);
        tick = setInterval(tickLeft, 1000);
        poll = setInterval(async function () {
          await refreshDurum(); if (!durum) return;
          var added = (durum.devices || []).length > before;
          if (added || !durum.pending) {
            clearInterval(poll); clearInterval(tick); pair = null;
            if (added) { st.msg = 'Tablet eşleşti: ' + ((durum.lastClaim && durum.lastClaim.name) || ''); schedule(); sync(true); }
            else st.pairErr = 'Kodun süresi doldu. Yeni kod oluşturun.';
            render();
          }
        }, 2000);
      } catch (e) { st.pairErr = e.message; render(); }
    }
    function cancelPair() { clearInterval(poll); clearInterval(tick); pair = null; api('/api/eslesme/iptal', {}).catch(function () {}); render(); }

    listeners.push(render); panels.push(box);
    box.__dispose = function () { alive = false; clearInterval(poll); clearInterval(tick); var i = listeners.indexOf(render); if (i >= 0) listeners.splice(i, 1); if (pair) api('/api/eslesme/iptal', {}).catch(function () {}); };
    refreshDurum().then(render); render();
    return box;
  }

  function inject() {
    var h3 = Array.prototype.find.call(document.querySelectorAll('h3'), function (x) { return x.textContent.trim() === 'Uygulama Ayarları'; });
    if (!h3) return;
    var form = null, n = h3.parentElement;
    for (var i = 0; i < 8 && n && !form; i++, n = n.parentElement) form = n.querySelector('form');
    if (!form) return;
    var bar = form.previousElementSibling;
    if (!bar || bar.querySelector('.se-tab')) return;
    var tab = el('button', 'se-tab flex items-center gap-1.5 px-3 py-2 border-b-2 border-transparent text-slate-500 transition cursor-pointer whitespace-nowrap', '<span>Tablet Eşleme</span>');
    tab.type = 'button';
    var panel = null;
    function open() {
      if (panel) return;
      bar.classList.add('se-aktif'); tab.classList.add('se-on');
      form.style.display = 'none';
      panel = buildPanel(); panel.classList.add('p-5');
      form.parentNode.insertBefore(panel, form.nextSibling);
    }
    function close() {
      if (!panel) return;
      bar.classList.remove('se-aktif'); tab.classList.remove('se-on');
      form.style.display = ''; panel.__dispose(); panel.remove(); panel = null;
    }
    tab.onclick = open;
    bar.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b && b !== tab && !b.classList.contains('se-tab')) close(); }, true);
    bar.classList.add('se-bar'); bar.appendChild(tab);
  }

  var raf = 0;
  new MutationObserver(function () { if (!raf) raf = requestAnimationFrame(function () { raf = 0; panels = panels.filter(function (p) { if (p.isConnected) return true; p.__dispose(); return false; }); inject(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });

  window.__eslesme = { sync: sync };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
