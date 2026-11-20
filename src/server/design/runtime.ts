/**
 * Runtime tetap yang disisipkan ke dalam frame desain. Skrip ini berjalan di
 * dokumen halaman (asal buram, `sandbox="allow-scripts"`) dan hanya berbicara
 * dengan klien lewat `postMessage` kanal `jejak-design-v1`: mengukur tinggi,
 * melaporkan hover/pilihan elemen, meneruskan rute hash, dan mencegat tautan
 * luar. Runtime tidak menulis berkas dan tidak melakukan permintaan jaringan.
 */

/** Placeholder yang diganti literal slug saat skrip dirakit. */
const SLUG_PLACEHOLDER = "__JEJAK_SLUG_DESAIN__";

/**
 * Escapes a value into a safe JavaScript string literal inside a `<script>`
 * element: JSON handles quotes/backslashes, then `<`, U+2028, dan U+2029
 * di-escape agar tidak menutup tag skrip atau memutus literal.
 */
function escapeSlugLiteral(slug: string): string {
  return JSON.stringify(slug)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Sumber runtime dengan slug sudah disisipkan sebagai literal. */
export function buildRuntimeSource(slug: string): string {
  return RUNTIME_SOURCE.split(SLUG_PLACEHOLDER).join(escapeSlugLiteral(slug));
}

/** Membungkus sumber runtime sebagai elemen `<script>` siap `srcdoc`. */
export function frameRuntimeScript(slug: string): string {
  return `<script data-jejak-design-runtime>${buildRuntimeSource(slug)}</script>`;
}

/**
 * Sumber JS runtime (ES2019, IIFE, `"use strict"`), dengan placeholder slug.
 * Teks `</script` sengaja tidak pernah muncul di sini.
 */
export const RUNTIME_SOURCE = `(function () {
  "use strict";
  var CHANNEL = "jejak-design-v1";
  var SLUG = ${SLUG_PLACEHOLDER};
  var BATAS_PESAN = 65536;
  var BATAS_HTML = 2048;
  var BATAS_TEKS = 200;
  var BATAS_SELECTOR = 500;
  var BATAS_SHOT = 6000000;
  var BATAS_LEBAR_TANGKAP = 4096;
  var BATAS_TINGGI_TANGKAP = 6000;
  var BATAS_SISI_PIKSEL = 8192;
  var BATAS_LUAS_PIKSEL = 40000000;
  var BATAS_WAKTU_TANGKAP = 10000;
  var ID_TANGKAP = /^[A-Za-z0-9_-]{1,64}$/;
  var mode = "preview";
  var overlay = null;
  var tinggiTerakhir = -1;
  var bingkai = 0;
  var hoverBingkai = 0;
  var geser = null;
  var menangkap = false;
  var daftarPin = [];

  function kirim(pesan, batas) {
    pesan.channel = CHANNEL;
    var teks;
    try {
      teks = JSON.stringify(pesan);
    } catch (galat) {
      return;
    }
    var maks = typeof batas === "number" ? batas : BATAS_PESAN;
    if (teks.length > maks) return;
    try {
      window.parent.postMessage(pesan, "*");
    } catch (galat) {}
  }

  function bulat(n) {
    return Math.round(n);
  }

  function bounds(el) {
    var r = el.getBoundingClientRect();
    return {
      x: bulat(r.left),
      y: bulat(r.top),
      width: bulat(r.width),
      height: bulat(r.height)
    };
  }

  function teksDari(el) {
    var t = el.textContent || "";
    return t.replace(/\\s+/g, " ").trim().slice(0, BATAS_TEKS);
  }

  function tagDari(el) {
    return el.tagName ? el.tagName.toLowerCase() : "";
  }

  function labelDari(el) {
    var tag = tagDari(el);
    var role = el.getAttribute ? el.getAttribute("role") : null;
    if (tag === "button" || role === "button") return "Tombol";
    if (tag === "input") {
      var jenis = (el.getAttribute("type") || "").toLowerCase();
      if (jenis === "button" || jenis === "submit") return "Tombol";
      return "Input";
    }
    if (tag === "img" || tag === "svg" || tag === "picture" || tag === "video" || tag === "canvas") {
      return "Gambar";
    }
    if (tag === "textarea" || tag === "select") return "Input";
    if (tag === "section" || tag === "header" || tag === "footer" || tag === "nav" ||
        tag === "main" || tag === "aside" || tag === "article") {
      return "Bagian";
    }
    if (el.children && el.children.length > 0) return "Grup";
    return "Teks";
  }

  var KUNCI_GAYA = [
    "color", "backgroundColor", "fontFamily", "fontSize", "fontWeight",
    "padding", "margin", "borderRadius", "display"
  ];

  function gayaDari(el) {
    var hasil = {};
    var g = window.getComputedStyle(el);
    for (var i = 0; i < KUNCI_GAYA.length; i += 1) {
      var nilai = g[KUNCI_GAYA[i]];
      if (typeof nilai === "string") hasil[KUNCI_GAYA[i]] = nilai;
    }
    return hasil;
  }

  function escapeAttr(nilai) {
    return String(nilai).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
  }

  function unik(selector, el) {
    try {
      var daftar = document.querySelectorAll(selector);
      return daftar.length === 1 && daftar[0] === el;
    } catch (galat) {
      return false;
    }
  }

  function segmen(el) {
    var tag = tagDari(el);
    var n = 1;
    var sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) n += 1;
    }
    return tag + ":nth-of-type(" + n + ")";
  }

  function penjangkaran(el) {
    if (el.id) {
      var olehId = '[id="' + escapeAttr(el.id) + '"]';
      if (unik(olehId, el)) return olehId;
    }
    var testid = el.getAttribute ? el.getAttribute("data-testid") : null;
    if (testid) {
      var olehTestid = '[data-testid="' + escapeAttr(testid) + '"]';
      if (unik(olehTestid, el)) return olehTestid;
    }
    return "";
  }

  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    var sendiri = penjangkaran(el);
    if (sendiri) return sendiri;
    var bagian = [];
    var cur = el;
    while (cur && cur.nodeType === 1) {
      bagian.unshift(segmen(cur));
      var kandidat = bagian.join(" > ");
      if (unik(kandidat, el)) return kandidat;
      if (bagian.length > 1) {
        var jangkar = penjangkaran(cur);
        if (jangkar) {
          var berjangkar = jangkar + " > " + bagian.slice(1).join(" > ");
          if (unik(berjangkar, el)) return berjangkar;
        }
      }
      if (cur === document.documentElement) break;
      cur = cur.parentElement;
    }
    return bagian.join(" > ");
  }

  function pastikanOverlay() {
    if (overlay && overlay.parentNode) return overlay;
    overlay = document.createElement("div");
    overlay.setAttribute("data-jejak-sorot", "");
    var s = overlay.style;
    s.position = "fixed";
    s.pointerEvents = "none";
    s.outline = "2px solid #2f6fed";
    s.zIndex = "2147483647";
    s.boxSizing = "border-box";
    s.left = "0px";
    s.top = "0px";
    s.width = "0px";
    s.height = "0px";
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  function taruhOverlay(el) {
    var kotak = pastikanOverlay();
    var r = el.getBoundingClientRect();
    kotak.style.left = r.left + "px";
    kotak.style.top = r.top + "px";
    kotak.style.width = r.width + "px";
    kotak.style.height = r.height + "px";
    kotak.style.display = "block";
  }

  function hapusOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function tampilkanToast(pesan) {
    var lama = document.querySelector("[data-jejak-toast]");
    if (lama && lama.parentNode) lama.parentNode.removeChild(lama);
    var el = document.createElement("div");
    el.setAttribute("data-jejak-toast", "");
    el.textContent = pesan;
    var s = el.style;
    s.position = "fixed";
    s.left = "12px";
    s.bottom = "12px";
    s.padding = "8px 12px";
    s.background = "#1f2328";
    s.color = "#ffffff";
    s.fontFamily = "system-ui, sans-serif";
    s.fontSize = "13px";
    s.borderRadius = "6px";
    s.zIndex = "2147483647";
    s.pointerEvents = "none";
    (document.body || document.documentElement).appendChild(el);
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2000);
  }

  function ukur() {
    var akar = document.documentElement;
    if (!akar) return;
    var tinggi = Math.ceil(akar.scrollHeight);
    if (tinggi === tinggiTerakhir) return;
    tinggiTerakhir = tinggi;
    kirim({ type: "size", height: tinggi });
  }

  function jadwalkanUkur() {
    if (bingkai) return;
    bingkai = window.requestAnimationFrame(function () {
      bingkai = 0;
      ukur();
      if (daftarPin.length > 0) gambarPin();
    });
  }

  // Pin ikut bergeser saat tata letak berubah; cukup sekali per bingkai.
  function jadwalkanPin() {
    if (daftarPin.length === 0) return;
    jadwalkanUkur();
  }

  function diDalamPin(target) {
    if (!target || target.nodeType !== 1) return false;
    if (!target.closest) return false;
    try {
      return target.closest("[data-jejak-pin]") !== null;
    } catch (galat) {
      return false;
    }
  }

  function klikPin(e) {
    e.stopPropagation();
    e.preventDefault();
    kirim({ type: "pin", id: this.getAttribute("data-pin-id") });
  }

  function gambarPin() {
    var lama = document.querySelectorAll("[data-jejak-pin]");
    for (var i = 0; i < lama.length; i += 1) {
      if (lama[i].parentNode) lama[i].parentNode.removeChild(lama[i]);
    }
    var perSelector = {};
    for (var j = 0; j < daftarPin.length; j += 1) {
      var pin = daftarPin[j];
      var el = null;
      try {
        el = document.querySelector(pin.selector);
      } catch (galat) {
        el = null;
      }
      if (!el) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var indeks = perSelector[pin.selector] || 0;
      perSelector[pin.selector] = indeks + 1;

      var kiri = r.right + window.pageXOffset - 12 - indeks * 22;
      var atas = r.top + window.pageYOffset - 12;
      if (kiri < 0) kiri = 0;
      if (atas < 0) atas = 0;

      var elPin = document.createElement("div");
      elPin.setAttribute("data-jejak-pin", "");
      elPin.setAttribute("data-pin-id", pin.id);
      elPin.setAttribute("data-status", pin.done ? "done" : "open");
      elPin.setAttribute("role", "button");
      elPin.setAttribute("aria-label", "Komentar " + pin.n);
      elPin.textContent = String(pin.n);
      var s = elPin.style;
      s.position = "absolute";
      s.left = kiri + "px";
      s.top = atas + "px";
      s.width = "20px";
      s.height = "20px";
      s.borderRadius = "50%";
      s.font = "600 11px/20px system-ui,sans-serif";
      s.textAlign = "center";
      s.color = "#ffffff";
      s.background = pin.done ? "#868e96" : "#e8590c";
      s.boxShadow = "0 1px 3px rgba(0,0,0,.35)";
      s.cursor = "pointer";
      s.zIndex = "2147483646";
      s.boxSizing = "border-box";
      s.userSelect = "none";
      elPin.addEventListener("click", klikPin);
      (document.body || document.documentElement).appendChild(elPin);
    }
  }

  function jadwalkanHover(e) {
    if (mode !== "select" || hoverBingkai) return;
    if (diDalamPin(e.target)) return;
    var target = e.target;
    hoverBingkai = window.requestAnimationFrame(function () {
      hoverBingkai = 0;
      if (!target || target.nodeType !== 1) return;
      kirim({
        type: "hover",
        bounds: bounds(target),
        tag: tagDari(target),
        label: labelDari(target)
      });
    });
  }

  function pilih(e) {
    if (mode !== "select") return;
    // Pin punya pendengar klik sendiri; biarkan klik sampai ke sana.
    if (diDalamPin(e.target)) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    taruhOverlay(el);
    kirim({
      type: "select",
      selector: buildSelector(el),
      tag: tagDari(el),
      text: teksDari(el),
      html: (el.outerHTML || "").slice(0, BATAS_HTML),
      bounds: bounds(el),
      style: gayaDari(el)
    });
  }

  function tautan(e) {
    var target = e.target;
    if (!target || target.nodeType !== 1 || !target.closest) return;
    var a = target.closest("a[href]");
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") {
      // Navigasi fragmen bawaan memuat ulang dokumen srcdoc menjadi
      // about:blank#... dan membuang runtime; set hash langsung saja.
      e.preventDefault();
      try {
        location.hash = href;
      } catch (galat) {}
      return;
    }
    e.preventDefault();
    tampilkanToast("Tautan luar tidak dibuka dari frame");
  }

  document.addEventListener("submit", function (e) {
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener("wheel", function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    kirim({
      type: "wheel",
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ctrlKey: true,
      clientX: e.clientX,
      clientY: e.clientY
    });
  }, { passive: false });

  document.addEventListener("mousedown", function (e) {
    if (e.button !== 1) return;
    e.preventDefault();
    geser = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener("mousemove", function (e) {
    if (!geser) return;
    var dx = e.clientX - geser.x;
    var dy = e.clientY - geser.y;
    geser.x = e.clientX;
    geser.y = e.clientY;
    kirim({ type: "pan", dx: dx, dy: dy });
  }, true);

  document.addEventListener("mouseup", function (e) {
    if (e.button !== 1) return;
    geser = null;
  }, true);

  document.addEventListener("mousemove", jadwalkanHover);
  document.addEventListener("click", pilih, true);
  document.addEventListener("click", tautan);

  window.addEventListener("hashchange", function () {
    kirim({ type: "route", hash: (location.hash || "").slice(0, 200) });
  });

  function kirimGalatTangkap(id, alasan) {
    kirim({ type: "shot-error", id: id, reason: alasan });
  }

  // Kanvas menampung raster; lepaskan setelah selesai agar memori frame
  // tidak menumpuk antar tangkapan.
  function lepasKanvas(kanvas) {
    try {
      kanvas.width = 0;
      kanvas.height = 0;
    } catch (galat) {}
  }

  // Tangkapan scene untuk ekspor Figma: menelusuri DOM dan melaporkan kotak,
  // warna, garis tepi, sudut, dan teks sebagai pohon sederhana. Hanya membaca
  // gaya terhitung; tidak mengubah halaman.
  var BATAS_SCENE = 6000000;
  var BATAS_NODE_SCENE = 18000;
  var BATAS_DALAM_SCENE = 55;
  var kanvasWarna = null;
  var cacheWarna = {};

  function warnaDari(nilai) {
    if (!nilai || nilai === "transparent") return null;
    if (cacheWarna.hasOwnProperty(nilai)) return cacheWarna[nilai];
    var hasil = null;
    try {
      if (!kanvasWarna) {
        kanvasWarna = document.createElement("canvas");
        kanvasWarna.width = 1;
        kanvasWarna.height = 1;
      }
      var ctx = kanvasWarna.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = nilai;
      ctx.fillRect(0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      var a = d[3] / 255;
      if (a > 0) {
        // Piksel dari kanvas berpremultiplied; kembalikan ke warna asli.
        hasil = {
          r: Math.min(1, d[0] / 255 / a),
          g: Math.min(1, d[1] / 255 / a),
          b: Math.min(1, d[2] / 255 / a),
          a: a
        };
      }
    } catch (galat) {
      hasil = null;
    }
    cacheWarna[nilai] = hasil;
    return hasil;
  }

  function angka(nilai) {
    var n = parseFloat(nilai);
    return isFinite(n) ? n : 0;
  }

  function namaNode(el) {
    var nama = el.tagName.toLowerCase();
    if (el.id) nama += "#" + String(el.id).slice(0, 40);
    else if (typeof el.className === "string" && el.className.trim()) {
      nama += "." + el.className.trim().split(" ")[0].slice(0, 40);
    }
    return nama;
  }

  function jejariSudut(cs, lebar, tinggi) {
    function satu(nilai) {
      var teks = String(nilai || "0").split(" ")[0];
      if (teks.indexOf("%") !== -1) return (angka(teks) * Math.min(lebar, tinggi)) / 100;
      return angka(teks);
    }
    var a = satu(cs.borderTopLeftRadius);
    var b = satu(cs.borderTopRightRadius);
    var c = satu(cs.borderBottomRightRadius);
    var d = satu(cs.borderBottomLeftRadius);
    var batas = Math.min(lebar, tinggi) / 2;
    a = Math.min(a, batas);
    b = Math.min(b, batas);
    c = Math.min(c, batas);
    d = Math.min(d, batas);
    if (a === 0 && b === 0 && c === 0 && d === 0) return undefined;
    if (a === b && b === c && c === d) return a;
    return [a, b, c, d];
  }

  function garisTepi(cs) {
    var lebar = angka(cs.borderTopWidth);
    if (lebar <= 0) return undefined;
    if (angka(cs.borderRightWidth) !== lebar || angka(cs.borderBottomWidth) !== lebar ||
        angka(cs.borderLeftWidth) !== lebar) return undefined;
    if (cs.borderTopStyle === "none" || cs.borderTopStyle === "hidden") return undefined;
    var warna = warnaDari(cs.borderTopColor);
    if (!warna) return undefined;
    return { color: warna, weight: lebar };
  }

  function simpulTeks(teks, el, cs, kotak, offX, offY) {
    var isi = String(teks.nodeValue || "");
    if (cs.whiteSpace.indexOf("pre") === -1) {
      var bersih = "";
      var spasi = false;
      for (var i = 0; i < isi.length; i += 1) {
        var ch = isi.charAt(i);
        var putih = ch === " " || ch === "\\n" || ch === "\\t" || ch === "\\r" || ch === "\\f";
        if (putih) {
          if (!spasi) bersih += " ";
          spasi = true;
        } else {
          bersih += ch;
          spasi = false;
        }
      }
      isi = bersih.trim();
    }
    if (isi.length === 0) return null;
    if (cs.textTransform === "uppercase") isi = isi.toUpperCase();
    else if (cs.textTransform === "lowercase") isi = isi.toLowerCase();
    var warna = warnaDari(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    var rentang = document.createRange();
    rentang.selectNodeContents(teks);
    var r = rentang.getBoundingClientRect();
    if (!(r.width > 0) && !(r.height > 0)) return null;
    var keluarga = String(cs.fontFamily || "Inter").split(",")[0].trim();
    if ((keluarga.charAt(0) === '"' || keluarga.charAt(0) === "'") && keluarga.length > 1) {
      keluarga = keluarga.slice(1, keluarga.length - 1);
    }
    var rata = cs.textAlign;
    if (rata === "start") rata = "left";
    else if (rata === "end") rata = "right";
    if (rata !== "left" && rata !== "center" && rata !== "right" && rata !== "justify") rata = "left";
    var spec = {
      characters: isi.slice(0, 20000),
      fontSize: Math.max(1, angka(cs.fontSize)),
      fontFamily: keluarga || "Inter",
      fontWeight: Math.min(900, Math.max(100, angka(cs.fontWeight) || 400)),
      italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
      color: warna,
      align: rata
    };
    var tinggiBaris = angka(cs.lineHeight);
    if (cs.lineHeight !== "normal" && tinggiBaris > 0) spec.lineHeight = tinggiBaris;
    var jarak = angka(cs.letterSpacing);
    if (cs.letterSpacing !== "normal" && jarak !== 0) spec.letterSpacing = jarak;
    // Satu baris: Figma memakai ukuran otomatis agar font pengganti yang lebih
    // lebar tidak membungkus teks.
    var barisRef = spec.lineHeight || spec.fontSize * 1.4;
    if (r.height <= barisRef * 1.5) spec.singleLine = true;
    var lebarTeks = r.width + 2 + r.width * 0.02;
    return {
      kind: "text",
      name: isi.slice(0, 40),
      x: r.left + window.pageXOffset - offX,
      y: r.top + window.pageYOffset - offY,
      width: lebarTeks,
      height: r.height,
      text: spec
    };
  }

  // Gradien linear pertama dari nilai background-image terhitung. Sudut CSS,
  // titik warna dengan posisi persen atau px (tanpa posisi dibagi rata).
  function bagiAtas(teks) {
    var bagian = [];
    var dalam = 0;
    var awal = 0;
    for (var i = 0; i < teks.length; i += 1) {
      var ch = teks.charAt(i);
      if (ch === "(") dalam += 1;
      else if (ch === ")") dalam -= 1;
      else if (ch === "," && dalam === 0) {
        bagian.push(teks.slice(awal, i).trim());
        awal = i + 1;
      }
    }
    bagian.push(teks.slice(awal).trim());
    return bagian;
  }

  var ARAH_GRADIEN = {
    "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
    "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
    "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315
  };

  function gradienDari(nilai, lebar, tinggi) {
    var mulai = String(nilai || "").indexOf("linear-gradient(");
    if (mulai === -1) return null;
    var terbuka = mulai + 16;
    var dalam = 1;
    var akhir = terbuka;
    while (akhir < nilai.length && dalam > 0) {
      var c = nilai.charAt(akhir);
      if (c === "(") dalam += 1;
      else if (c === ")") dalam -= 1;
      akhir += 1;
    }
    if (dalam !== 0) return null;
    var bagian = bagiAtas(nilai.slice(terbuka, akhir - 1));
    var sudut = 180;
    var arah = bagian[0].toLowerCase();
    if (arah.slice(-3) === "deg") {
      sudut = parseFloat(arah);
      bagian.shift();
    } else if (ARAH_GRADIEN.hasOwnProperty(arah)) {
      sudut = ARAH_GRADIEN[arah];
      bagian.shift();
    } else if (arah.slice(-3) === "rad" || arah.slice(-4) === "turn" || arah.slice(-4) === "grad") {
      return null;
    }
    if (!(sudut === sudut) || bagian.length < 2 || bagian.length > 16) return null;
    var titik = [];
    for (var i = 0; i < bagian.length; i += 1) {
      var item = bagian[i];
      var posisi = null;
      var spasi = -1;
      var d = 0;
      for (var j = item.length - 1; j >= 0; j -= 1) {
        var k = item.charAt(j);
        if (k === ")") d += 1;
        else if (k === "(") d -= 1;
        else if (k === " " && d === 0) {
          spasi = j;
          break;
        }
      }
      var warnaTeks = item;
      if (spasi !== -1) {
        var sisa = item.slice(spasi + 1);
        var angkaSisa = parseFloat(sisa);
        if (sisa.slice(-1) === "%" && angkaSisa === angkaSisa) {
          posisi = angkaSisa / 100;
          warnaTeks = item.slice(0, spasi).trim();
        } else if (sisa.slice(-2) === "px" && angkaSisa === angkaSisa) {
          var panjang = Math.abs(lebar * Math.sin(sudut * Math.PI / 180)) + Math.abs(tinggi * Math.cos(sudut * Math.PI / 180));
          posisi = panjang > 0 ? angkaSisa / panjang : 0;
          warnaTeks = item.slice(0, spasi).trim();
        }
      }
      var w = warnaDari(warnaTeks);
      if (!w) return null;
      titik.push({ color: w, position: posisi });
    }
    if (titik[0].position === null) titik[0].position = 0;
    if (titik[titik.length - 1].position === null) titik[titik.length - 1].position = 1;
    var terakhir = 0;
    for (var m = 1; m < titik.length; m += 1) {
      if (titik[m].position !== null) {
        var jarakTitik = m - terakhir;
        for (var n = terakhir + 1; n < m; n += 1) {
          titik[n].position = titik[terakhir].position + (titik[m].position - titik[terakhir].position) * (n - terakhir) / jarakTitik;
        }
        terakhir = m;
      }
    }
    for (var q = 0; q < titik.length; q += 1) {
      titik[q].position = Math.min(1, Math.max(0, titik[q].position));
      if (q > 0 && titik[q].position < titik[q - 1].position) titik[q].position = titik[q - 1].position;
    }
    return { angle: sudut, stops: titik };
  }

  // Flex satu baris tanpa margin anak dan tanpa anak mutlak menjadi auto layout.
  function tataLetakDari(el, cs) {
    if (cs.display !== "flex" && cs.display !== "inline-flex") return null;
    if (cs.flexWrap !== "nowrap") return null;
    var arah = cs.flexDirection === "row" ? "row" : cs.flexDirection === "column" ? "column" : null;
    if (!arah) return null;
    var main = { "flex-start": "start", "start": "start", "normal": "start", "center": "center", "flex-end": "end", "end": "end", "space-between": "between" }[cs.justifyContent];
    var silang = { "normal": "start", "stretch": "start", "flex-start": "start", "start": "start", "center": "center", "flex-end": "end", "end": "end" }[cs.alignItems];
    if (!main || !silang) return null;
    for (var i = 0; i < el.children.length; i += 1) {
      var ac = window.getComputedStyle(el.children[i]);
      if (ac.display === "none") continue;
      if (ac.position === "absolute" || ac.position === "fixed") return null;
      if (angka(ac.marginLeft) !== 0 || angka(ac.marginRight) !== 0 ||
          angka(ac.marginTop) !== 0 || angka(ac.marginBottom) !== 0) return null;
    }
    var gap = arah === "row" ? angka(cs.columnGap) : angka(cs.rowGap);
    var pad = angka(cs.borderTopWidth);
    if (pad !== 0 || angka(cs.borderRightWidth) !== 0 || angka(cs.borderBottomWidth) !== 0 ||
        angka(cs.borderLeftWidth) !== 0) return null;
    return {
      direction: arah,
      gap: gap || 0,
      padding: [angka(cs.paddingTop), angka(cs.paddingRight), angka(cs.paddingBottom), angka(cs.paddingLeft)],
      main: main,
      cross: silang
    };
  }

  // Bayangan: nilai terhitung berbentuk "rgba(...) 0px 2px 8px 0px" dipisah
  // koma di tingkat atas; warna selalu di depan.
  function bayanganDari(nilai) {
    if (!nilai || nilai === "none") return undefined;
    var bagian = [];
    var dalamKurung = 0;
    var awal = 0;
    for (var i = 0; i < nilai.length; i += 1) {
      var ch = nilai.charAt(i);
      if (ch === "(") dalamKurung += 1;
      else if (ch === ")") dalamKurung -= 1;
      else if (ch === "," && dalamKurung === 0) {
        bagian.push(nilai.slice(awal, i));
        awal = i + 1;
      }
    }
    bagian.push(nilai.slice(awal));
    var hasil = [];
    for (var k = 0; k < bagian.length && hasil.length < 8; k += 1) {
      var teks = bagian[k].trim();
      var inset = false;
      if (teks.indexOf("inset") !== -1) {
        inset = true;
        teks = teks.split("inset").join(" ").trim();
      }
      var warnaTeks = "";
      var sisa = teks;
      var tutup = teks.indexOf(")");
      if (teks.indexOf("(") !== -1 && tutup !== -1) {
        warnaTeks = teks.slice(0, tutup + 1);
        sisa = teks.slice(tutup + 1);
      } else {
        var spasiPertama = teks.indexOf(" ");
        warnaTeks = spasiPertama === -1 ? teks : teks.slice(0, spasiPertama);
        sisa = spasiPertama === -1 ? "" : teks.slice(spasiPertama);
      }
      var warna = warnaDari(warnaTeks);
      var angkaSisa = sisa.trim().split(" ");
      if (!warna || angkaSisa.length < 2) continue;
      hasil.push({
        x: angka(angkaSisa[0]),
        y: angka(angkaSisa[1]),
        blur: Math.max(0, angka(angkaSisa[2] || "0")),
        spread: angka(angkaSisa[3] || "0"),
        color: warna,
        inset: inset
      });
    }
    return hasil.length > 0 ? hasil : undefined;
  }

  // Rasterisasi gambar ke data base64 (maksimal sisi 800 px). Gagal (lintas
  // asal) mengembalikan null sehingga kotak abu-abu tetap dipakai.
  var BATAS_SISI_GAMBAR = 800;
  var BATAS_GAMBAR_B64 = 700000;
  function rasterGambar(gambar) {
    try {
      var w = gambar.naturalWidth || gambar.width;
      var h = gambar.naturalHeight || gambar.height;
      if (!(w > 0) || !(h > 0)) return null;
      var skala = Math.min(1, BATAS_SISI_GAMBAR / Math.max(w, h));
      var kanvas = document.createElement("canvas");
      kanvas.width = Math.max(1, Math.round(w * skala));
      kanvas.height = Math.max(1, Math.round(h * skala));
      kanvas.getContext("2d").drawImage(gambar, 0, 0, kanvas.width, kanvas.height);
      var url = kanvas.toDataURL("image/png");
      if (url.length > BATAS_GAMBAR_B64) url = kanvas.toDataURL("image/jpeg", 0.8);
      lepasKanvas(kanvas);
      if (url.length > BATAS_GAMBAR_B64) return null;
      var koma = url.indexOf(",");
      return koma === -1 ? null : url.slice(koma + 1);
    } catch (galat) {
      return null;
    }
  }

  function muatGambar(sumber) {
    return new Promise(function (selesai) {
      var gambar = new Image();
      var pewaktu = setTimeout(function () { selesai(null); }, 4000);
      gambar.onload = function () { clearTimeout(pewaktu); selesai(gambar); };
      gambar.onerror = function () { clearTimeout(pewaktu); selesai(null); };
      gambar.src = sumber;
    });
  }

  // Tugas gambar untuk satu elemen: img, svg inline, atau background-image url().
  function tugasGambar(el, tag, cs, lebar, tinggi) {
    var fitCss = cs.objectFit;
    var fit = fitCss === "cover" ? "fill" : fitCss === "contain" || fitCss === "scale-down" ? "fit" : "stretch";
    if (tag === "img") {
      if (el.complete && el.naturalWidth > 0) {
        return Promise.resolve({ data: rasterGambar(el), fit: fit });
      }
      return muatGambar(el.currentSrc || el.src).then(function (g) {
        return { data: g ? rasterGambar(g) : null, fit: fit };
      });
    }
    if (tag === "svg") {
      var salinan = el.cloneNode(true);
      // Margin/posisi dari style inline menggeser svg mandiri keluar kanvas.
      salinan.removeAttribute("style");
      salinan.removeAttribute("class");
      if (!salinan.getAttribute("xmlns")) salinan.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      if (!salinan.getAttribute("width")) salinan.setAttribute("width", String(Math.round(lebar)));
      if (!salinan.getAttribute("height")) salinan.setAttribute("height", String(Math.round(tinggi)));
      var teksSvg = new XMLSerializer().serializeToString(salinan);
      return muatGambar("data:image/svg+xml;charset=utf-8," + encodeURIComponent(teksSvg)).then(function (g) {
        return { data: g ? rasterGambar(g) : null, fit: "stretch" };
      });
    }
    if (tag === "canvas") {
      try {
        var url = el.toDataURL("image/png");
        var k = url.indexOf(",");
        return Promise.resolve({ data: url.length < BATAS_GAMBAR_B64 && k !== -1 ? url.slice(k + 1) : null, fit: "stretch" });
      } catch (galat) {
        return Promise.resolve({ data: null, fit: "stretch" });
      }
    }
    var latar = cs.backgroundImage || "";
    var mulai = latar.indexOf("url(");
    if (mulai !== -1) {
      var akhirUrl = latar.indexOf(")", mulai);
      var alamat = latar.slice(mulai + 4, akhirUrl).trim();
      if ((alamat.charAt(0) === '"' || alamat.charAt(0) === "'") && alamat.length > 1) {
        alamat = alamat.slice(1, alamat.length - 1);
      }
      var fitLatar = cs.backgroundSize === "cover" ? "fill" : cs.backgroundSize === "contain" ? "fit" : "fill";
      return muatGambar(alamat).then(function (g) {
        return { data: g ? rasterGambar(g) : null, fit: fitLatar };
      });
    }
    return null;
  }

  function bangunScene() {
    var jumlah = { n: 0 };
    var peringatan = 0;
    var tugas = [];

    function telusuri(el, induk, absX, absY, dalam) {
      if (jumlah.n >= BATAS_NODE_SCENE) return;
      if (el.nodeType !== 1) return;
      var tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "meta" || tag === "link" ||
          tag === "head" || tag === "title" || tag === "noscript" || tag === "template") return;
      var cs = window.getComputedStyle(el);
      if (cs.display === "none") return;
      if (cs.display === "contents") {
        anakAnak(el, induk, absX, absY, dalam);
        return;
      }
      if (cs.visibility === "hidden" && tag !== "html") {
        anakAnak(el, induk, absX, absY, dalam);
        return;
      }
      var r = el.getBoundingClientRect();
      var kiri = r.left + window.pageXOffset;
      var atas = r.top + window.pageYOffset;
      if (!(r.width > 0) || !(r.height > 0)) {
        anakAnak(el, induk, absX, absY, dalam);
        return;
      }
      var opasitas = angka(cs.opacity);
      if (opasitas <= 0) return;
      var node = {
        kind: "box",
        name: namaNode(el),
        x: kiri - absX,
        y: atas - absY,
        width: r.width,
        height: r.height
      };
      var fill = warnaDari(cs.backgroundColor);
      var gambarLatar = cs.backgroundImage && cs.backgroundImage !== "none";
      if (fill) node.fill = fill;
      else if (gambarLatar && cs.backgroundImage.indexOf("gradient") === -1) {
        node.fill = { r: 0.85, g: 0.85, b: 0.85, a: 1 };
        node.abuCadangan = true;
      }
      if (gambarLatar) {
        var grad = gradienDari(cs.backgroundImage, r.width, r.height);
        if (grad) node.gradient = grad;
      }
      var tepi = garisTepi(cs);
      if (tepi) node.stroke = tepi;
      var sudut = jejariSudut(cs, r.width, r.height);
      if (sudut !== undefined) node.radius = sudut;
      if (opasitas < 1) node.opacity = opasitas;
      var bayangan = bayanganDari(cs.boxShadow);
      if (bayangan) node.shadows = bayangan;
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") node.clip = true;
      jumlah.n += 1;
      induk.push(node);
      if (gambarLatar && cs.backgroundImage.indexOf("url(") !== -1 && tugas.length < 60 &&
          tag !== "img" && tag !== "svg" && tag !== "canvas") {
        tugas.push({ node: node, kerja: tugasGambar(el, tag, cs, r.width, r.height) });
      }
      if (tag === "img" || tag === "svg" || tag === "canvas" || tag === "video" || tag === "picture") {
        var sumber = "";
        try {
          sumber = String(el.getAttribute("src") || "").slice(0, 60);
        } catch (galat) {}
        node.name = "gambar: " + (sumber || tag);
        if (!node.fill) {
          node.fill = { r: 0.85, g: 0.85, b: 0.85, a: 1 };
          node.abuCadangan = true;
        }
        if (tugas.length < 60) tugas.push({ node: node, kerja: tugasGambar(el, tag, cs, r.width, r.height) });
        return;
      }
      node.children = [];
      if (tag === "input" || tag === "textarea") {
        var nilai = String(el.value || el.placeholder || "");
        if (nilai) {
          var pad = angka(cs.paddingLeft) + angka(cs.borderLeftWidth);
          var tinggiHuruf = Math.max(1, angka(cs.fontSize));
          var warnaIsi = warnaDari(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
          node.children.push({
            kind: "text",
            name: nilai.slice(0, 40),
            x: pad,
            y: Math.max(0, (r.height - tinggiHuruf * 1.3) / 2),
            width: Math.max(1, r.width - pad * 2),
            height: tinggiHuruf * 1.3,
            text: {
              characters: nilai.slice(0, 2000),
              fontSize: tinggiHuruf,
              fontFamily: String(cs.fontFamily || "Inter").split(",")[0].trim().split('"').join("").split("'").join("") || "Inter",
              fontWeight: Math.min(900, Math.max(100, angka(cs.fontWeight) || 400)),
              italic: false,
              color: warnaIsi,
              align: "left"
            }
          });
          jumlah.n += 1;
        }
        return;
      }
      var tata = tataLetakDari(el, cs);
      if (tata) node.layout = tata;
      anakAnak(el, node.children, kiri, atas, dalam + 1, cs);
    }

    function anakAnak(el, induk, absX, absY, dalam, csInduk) {
      if (dalam > BATAS_DALAM_SCENE) {
        peringatan += 1;
        return;
      }
      var cs = csInduk || window.getComputedStyle(el);
      var anak = el.childNodes;
      for (var i = 0; i < anak.length; i += 1) {
        var c = anak[i];
        if (c.nodeType === 3) {
          var teks = simpulTeks(c, el, cs, null, absX, absY);
          if (teks && jumlah.n < BATAS_NODE_SCENE) {
            jumlah.n += 1;
            induk.push(teks);
          }
        } else if (c.nodeType === 1) {
          telusuri(c, induk, absX, absY, dalam);
        }
      }
    }

    var html = document.documentElement;
    var body = document.body || html;
    var lebar = Math.min(8192, Math.round(Math.max(html.scrollWidth, window.innerWidth, 1)));
    var tinggi = Math.min(8192, Math.round(Math.max(html.scrollHeight, body.scrollHeight, 1)));
    var csBody = window.getComputedStyle(body);
    var csHtml = window.getComputedStyle(html);
    var latar = warnaDari(csBody.backgroundColor) || warnaDari(csHtml.backgroundColor) ||
      { r: 1, g: 1, b: 1, a: 1 };
    var akar = {
      kind: "box",
      name: "body",
      x: 0,
      y: 0,
      width: lebar,
      height: tinggi,
      fill: latar,
      clip: true,
      children: []
    };
    anakAnak(body, akar.children, 0, 0, 0, csBody);
    return { width: lebar, height: tinggi, root: akar, tugas: tugas };
  }

  function tangkapScene(id) {
    var hasil;
    try {
      hasil = bangunScene();
    } catch (galat) {
      kirimGalatTangkap(id, "failed");
      return;
    }
    var selesaiSemua = Promise.all(hasil.tugas.map(function (t) {
      return Promise.resolve(t.kerja).then(function (r) { return r; }, function () { return null; });
    }));
    var batas = new Promise(function (selesai) {
      setTimeout(function () { selesai(null); }, 9000);
    });
    Promise.race([selesaiSemua, batas]).then(function (daftar) {
      var total = 0;
      if (daftar) {
        for (var i = 0; i < daftar.length; i += 1) {
          var r = daftar[i];
          if (!r || !r.data) continue;
          if (total + r.data.length > 4500000) continue;
          total += r.data.length;
          hasil.tugas[i].node.image = { data: r.data, fit: r.fit };
          // Abu-abu hanya cadangan bila rasterisasi gagal.
          if (hasil.tugas[i].node.abuCadangan) delete hasil.tugas[i].node.fill;
        }
      }
      var teks = "";
      try {
        teks = JSON.stringify(hasil.root, function (kunci, nilai) {
          return kunci === "abuCadangan" ? undefined : nilai;
        });
      } catch (galat) {
        kirimGalatTangkap(id, "failed");
        return;
      }
      if (teks.length > BATAS_SCENE) {
        kirimGalatTangkap(id, "too-large");
        return;
      }
      kirim({ type: "scene", id: id, width: hasil.width, height: hasil.height, root: hasil.root }, BATAS_SCENE + 4096);
    });
  }

  function tangkap(id, skala) {
    if (menangkap) {
      kirimGalatTangkap(id, "failed");
      return;
    }
    menangkap = true;
    var selesai = false;
    var kanvas = null;
    var pewaktu = setTimeout(function () {
      gagal("failed");
    }, BATAS_WAKTU_TANGKAP);

    function akhir() {
      if (selesai) return;
      selesai = true;
      menangkap = false;
      clearTimeout(pewaktu);
      if (kanvas) lepasKanvas(kanvas);
    }

    function gagal(alasan) {
      if (selesai) return;
      akhir();
      kirimGalatTangkap(id, alasan);
    }

    try {
      var akar = document.documentElement;
      if (!akar) {
        gagal("failed");
        return;
      }
      var lebar = Math.max(akar.scrollWidth, akar.clientWidth);
      var tinggi = Math.max(akar.scrollHeight, akar.clientHeight);
      if (lebar > BATAS_LEBAR_TANGKAP) lebar = BATAS_LEBAR_TANGKAP;
      if (tinggi > BATAS_TINGGI_TANGKAP) tinggi = BATAS_TINGGI_TANGKAP;
      if (lebar < 1 || tinggi < 1) {
        gagal("failed");
        return;
      }
      var pikselLebar = lebar * skala;
      var pikselTinggi = tinggi * skala;
      if (pikselLebar > BATAS_SISI_PIKSEL || pikselTinggi > BATAS_SISI_PIKSEL ||
          pikselLebar * pikselTinggi > BATAS_LUAS_PIKSEL) {
        gagal("too-large");
        return;
      }

      var klon;
      try {
        klon = akar.cloneNode(true);
      } catch (galat) {
        gagal("failed");
        return;
      }
      var buang = klon.querySelectorAll(
        "script, [data-jejak-sorot], [data-jejak-toast], [data-jejak-pin]"
      );
      for (var i = 0; i < buang.length; i += 1) {
        if (buang[i].parentNode) buang[i].parentNode.removeChild(buang[i]);
      }
      klon.removeAttribute("data-jejak-design-runtime");
      var semua = klon.querySelectorAll("[data-jejak-design-runtime]");
      for (var j = 0; j < semua.length; j += 1) {
        semua[j].removeAttribute("data-jejak-design-runtime");
      }

      var xml;
      try {
        xml = new XMLSerializer().serializeToString(klon);
      } catch (galat) {
        gagal("failed");
        return;
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + lebar +
        '" height="' + tinggi +
        '"><foreignObject x="0" y="0" width="100%" height="100%">' +
        xml + "</foreignObject></svg>";

      var gambar = new Image();
      function muat() {
        if (selesai) return;
        try {
          kanvas = document.createElement("canvas");
          kanvas.width = pikselLebar;
          kanvas.height = pikselTinggi;
          var konteks = kanvas.getContext("2d");
          if (!konteks) {
            gagal("failed");
            return;
          }
          konteks.scale(skala, skala);
          konteks.drawImage(gambar, 0, 0);
        } catch (galatGambar) {
          gagal("failed");
          return;
        }
        var dataUrl;
        try {
          dataUrl = kanvas.toDataURL("image/png");
        } catch (galatKanvas) {
          var nama = galatKanvas && galatKanvas.name ? String(galatKanvas.name) : "";
          gagal(nama === "SecurityError" ? "tainted" : "failed");
          return;
        }
        if (!dataUrl || dataUrl.indexOf("data:image/png;base64,") !== 0 ||
            dataUrl.length > BATAS_SHOT) {
          gagal(dataUrl ? "too-large" : "failed");
          return;
        }
        akhir();
        kirim({ type: "shot", id: id, width: pikselLebar, height: pikselTinggi, dataUrl: dataUrl }, BATAS_SHOT + 4096);
      }
      function galatMuat() {
        gagal("failed");
      }
      gambar.onerror = galatMuat;
      if (typeof gambar.decode === "function") {
        gambar.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        gambar.decode().then(muat, galatMuat);
      } else {
        gambar.onload = muat;
        gambar.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      }
    } catch (galatLuar) {
      gagal("failed");
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.channel !== CHANNEL) return;
    if (typeof data.type !== "string") return;
    if (data.type === "mode") {
      if (data.tool === "preview" || data.tool === "select") {
        mode = data.tool;
        if (mode !== "select") hapusOverlay();
      }
      return;
    }
    if (data.type === "clear-selection") {
      hapusOverlay();
      return;
    }
    if (data.type === "scene") {
      if (typeof data.id !== "string" || !ID_TANGKAP.test(data.id)) return;
      tangkapScene(data.id);
      return;
    }
    if (data.type === "capture") {
      if (typeof data.id !== "string" || !ID_TANGKAP.test(data.id)) return;
      var skala = data.scale === undefined ? 1 : data.scale;
      if (skala !== 1 && skala !== 2) return;
      tangkap(data.id, skala);
      return;
    }
    if (data.type === "pins") {
      if (!Array.isArray(data.pins)) return;
      var masuk = data.pins;
      if (masuk.length > 50) masuk = masuk.slice(0, 50);
      var bersih = [];
      for (var k = 0; k < masuk.length; k += 1) {
        var item = masuk[k];
        if (!item || typeof item !== "object") continue;
        if (typeof item.id !== "string" || !ID_TANGKAP.test(item.id)) continue;
        if (typeof item.selector !== "string" ||
            item.selector.length < 1 || item.selector.length > BATAS_SELECTOR) continue;
        if (typeof item.n !== "number" || !isFinite(item.n) ||
            Math.floor(item.n) !== item.n || item.n < 1 || item.n > 999) continue;
        if (typeof item.done !== "boolean") continue;
        bersih.push({ id: item.id, selector: item.selector, n: item.n, done: item.done });
      }
      daftarPin = bersih;
      gambarPin();
      return;
    }
    if (data.type === "highlight") {
      if (typeof data.selector !== "string" || data.selector.length > BATAS_SELECTOR) return;
      var el = null;
      try {
        el = document.querySelector(data.selector);
      } catch (galat) {
        el = null;
      }
      if (!el) return;
      taruhOverlay(el);
    }
  });

  if (document.readyState === "complete") {
    kirim({ type: "ready", slug: SLUG });
    jadwalkanUkur();
  } else {
    window.addEventListener("load", function () {
      kirim({ type: "ready", slug: SLUG });
    });
  }

  window.addEventListener("load", jadwalkanUkur);
  window.addEventListener("resize", jadwalkanUkur);

  // Pin digambar ulang saat halaman selesai dimuat atau ukuran berubah.
  window.addEventListener("load", jadwalkanPin);
  window.addEventListener("resize", jadwalkanPin);

  if (typeof window.ResizeObserver === "function") {
    var pengamat = new window.ResizeObserver(function () {
      jadwalkanUkur();
    });
    pengamat.observe(document.documentElement);
  } else {
    window.addEventListener("load", jadwalkanUkur);
  }
})();`;
