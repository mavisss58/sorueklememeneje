// Küçük QR kod üretici (bayt kipi, sürüm 1-10, düzeltme düzeyi M). Dış kütüphane gerektirmez.
// window.SoruQR.svg(metin, {olcek, bosluk}) -> SVG metni
(function () {
  'use strict';
  var ECC = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];      // bloktaki düzeltme kelimesi (M), sürüm 1..10
  var BLK = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];                // blok sayısı (M)

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var a = Math.floor(v / 7) + 2; r -= (25 * a - 10) * a - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function alignPos(v) {
    if (v === 1) return [];
    var n = Math.floor(v / 7) + 2, size = v * 4 + 17;
    var step = Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2, res = [6];
    for (var p = size - 7; res.length < n; p -= step) res.splice(1, 0, p);
    return res;
  }

  // GF(256) Reed-Solomon
  var EXP = [], LOG = [];
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  function gmul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function rsGen(deg) {
    var g = [1];
    for (var i = 0; i < deg; i++) {
      var n = g.concat([0]);
      for (var j = 0; j < g.length; j++) n[j + 1] ^= gmul(g[j], EXP[i]);
      g = n;
    }
    return g;                                              // en yüksek derece önce, başı 1
  }
  function rsRem(data, gen) {
    var deg = gen.length - 1, rem = []; for (var i = 0; i < deg; i++) rem.push(0);
    data.forEach(function (b) {
      var f = b ^ rem.shift(); rem.push(0);
      for (var i = 0; i < deg; i++) rem[i] ^= gmul(gen[i + 1], f);
    });
    return rem;
  }

  function utf8(s) { return Array.prototype.slice.call(new TextEncoder().encode(s)); }

  function encode(text) {
    var bytes = utf8(text), v, cap;
    for (v = 1; v <= 10; v++) {
      cap = Math.floor(rawModules(v) / 8) - ECC[v - 1] * BLK[v - 1];
      var need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
      if (Math.ceil(need / 8) <= cap) break;
    }
    if (v > 10) throw new Error('Metin QR için çok uzun');
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xec; bits.length < cap * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var k = 0; k < 8; k++) x = (x << 1) | bits[i + k]; data.push(x); }

    // bloklara böl, düzeltme kelimeleri ekle, serpiştir
    var nb = BLK[v - 1], eccLen = ECC[v - 1], raw = Math.floor(rawModules(v) / 8);
    var shortLen = Math.floor(raw / nb) - eccLen, nShort = nb - raw % nb, gen = rsGen(eccLen), blocks = [], off = 0;
    for (i = 0; i < nb; i++) {
      var len = shortLen + (i < nShort ? 0 : 1), d = data.slice(off, off + len); off += len;
      blocks.push({ d: d, e: rsRem(d, gen) });
    }
    var out = [];
    for (i = 0; i <= shortLen; i++) blocks.forEach(function (b) { if (i < b.d.length) out.push(b.d[i]); });
    for (i = 0; i < eccLen; i++) blocks.forEach(function (b) { out.push(b.e[i]); });
    return { v: v, codewords: out };
  }

  function build(text) {
    var enc = encode(text), v = enc.v, size = v * 4 + 17, i, j;
    var mod = [], fn = [];
    for (i = 0; i < size; i++) { mod.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function set(x, y, dark) { mod[y][x] = dark; fn[y][x] = true; }

    for (i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    var ap = alignPos(v);
    ap.forEach(function (cy, a) { ap.forEach(function (cx, b) {
      if ((a === 0 && b === 0) || (a === 0 && b === ap.length - 1) || (a === ap.length - 1 && b === 0)) return;
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }); });

    function formatBits(mask) {                            // düzey M = 0b00
      var d = (0 << 3) | mask, r = d;
      for (var k = 0; k < 10; k++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      return ((d << 10) | r) ^ 0x5412;
    }
    function drawFormat(mask) {
      var b = formatBits(mask), k;
      for (k = 0; k <= 5; k++) set(8, k, ((b >>> k) & 1) !== 0);
      set(8, 7, ((b >>> 6) & 1) !== 0); set(8, 8, ((b >>> 7) & 1) !== 0); set(7, 8, ((b >>> 8) & 1) !== 0);
      for (k = 9; k < 15; k++) set(14 - k, 8, ((b >>> k) & 1) !== 0);
      for (k = 0; k < 8; k++) set(size - 1 - k, 8, ((b >>> k) & 1) !== 0);
      for (k = 8; k < 15; k++) set(8, size - 15 + k, ((b >>> k) & 1) !== 0);
      set(8, size - 8, true);
    }
    function drawVersion() {
      if (v < 7) return;
      var r = v; for (var k = 0; k < 12; k++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
      var b = (v << 12) | r;
      for (k = 0; k < 18; k++) { var bit = ((b >>> k) & 1) !== 0, a = size - 11 + k % 3, c = Math.floor(k / 3); set(a, c, bit); set(c, a, bit); }
    }
    drawFormat(0); drawVersion();                           // alanı ayır

    // veri kelimelerini yılan sırasıyla yerleştir
    var cw = enc.codewords, bit = 0, data = [];
    for (i = 0; i < cw.length; i++) for (j = 7; j >= 0; j--) data.push(((cw[i] >>> j) & 1) !== 0);
    var base = mod.map(function (r) { return r.slice(); });
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        var x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bit < data.length) base[y][x] = data[bit++];
      }
    }
    var maskFns = [
      function (x, y) { return (x + y) % 2 === 0; }, function (x, y) { return y % 2 === 0; },
      function (x) { return x % 3 === 0; }, function (x, y) { return (x + y) % 3 === 0; },
      function (x, y) { return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; },
      function (x, y) { return x * y % 2 + x * y % 3 === 0; },
      function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
      function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }];
    function apply(mask) {
      var m = base.map(function (r) { return r.slice(); });
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && maskFns[mask](x, y)) m[y][x] = !m[y][x];
      return m;
    }
    function penalty(m) {
      var p = 0, y, x, run, col;
      for (var pass = 0; pass < 2; pass++) for (y = 0; y < size; y++) {
        run = 0; col = null;
        for (x = 0; x < size; x++) {
          var c = pass ? m[x][y] : m[y][x];
          if (c === col) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { col = c; run = 1; }
        }
      }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
      var dark = 0; m.forEach(function (r) { r.forEach(function (c) { if (c) dark++; }); });
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    }
    var best = 0, bestP = Infinity, bestM = null;
    for (var mk = 0; mk < 8; mk++) { var mm = apply(mk), pp = penalty(mm); if (pp < bestP) { bestP = pp; best = mk; bestM = mm; } }
    // biçim bilgisini seçilen maskeyle yeniden yaz
    mod = bestM; drawFormat(best); drawVersion();
    return { size: size, mod: mod };
  }

  window.SoruQR = {
    svg: function (text, o) {
      o = o || {}; var q = build(text), pad = o.bosluk == null ? 4 : o.bosluk, n = q.size + pad * 2, d = '';
      for (var y = 0; y < q.size; y++) for (var x = 0; x < q.size; x++) if (q.mod[y][x]) d += 'M' + (x + pad) + ',' + (y + pad) + 'h1v1h-1z';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="QR kod">' +
        '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    },
    _build: build
  };
})();
