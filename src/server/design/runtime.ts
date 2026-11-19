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
    });
  }

  function jadwalkanHover(e) {
    if (mode !== "select" || hoverBingkai) return;
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
      var buang = klon.querySelectorAll("script, [data-jejak-sorot], [data-jejak-toast]");
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
    if (data.type === "capture") {
      if (typeof data.id !== "string" || !ID_TANGKAP.test(data.id)) return;
      var skala = data.scale === undefined ? 1 : data.scale;
      if (skala !== 1 && skala !== 2) return;
      tangkap(data.id, skala);
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

  if (typeof window.ResizeObserver === "function") {
    var pengamat = new window.ResizeObserver(function () {
      jadwalkanUkur();
    });
    pengamat.observe(document.documentElement);
  } else {
    window.addEventListener("load", jadwalkanUkur);
  }
})();`;
