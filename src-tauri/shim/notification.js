/*
 * Shim notifikasi native untuk jendela desktop Jejak.
 *
 * WKWebView tak menyediakan API Web Notification, jadi `window.Notification`
 * selalu kosong dan klien Jejak tak pernah bisa menampilkan notifikasi.
 * Skrip ini menyuntik kelas Notification yang kompatibel dengan pemakaian
 * klien (lihat src/client/lib/notify.ts) dan meneruskan ke plugin notifikasi
 * Tauri lewat `window.__TAURI_INTERNALS__.invoke`.
 *
 * Skrip ini disuntik lewat `WebviewWindowBuilder::initialization_script`,
 * jadi ia berjalan sebelum skrip halaman. Kalau halaman dimuat di luar
 * aplikasi desktop (mis. di browser biasa), `__TAURI_INTERNALS__` tak ada
 * dan shim ini tak mengubah apa pun.
 */

(function () {
  "use strict";

  var root = typeof globalThis !== "undefined" ? globalThis : this;
  // Di dalam webview, `globalThis === window`. Di luar webview (mis. tes),
  // global `window` bisa punya bridge Tauri sendiri.
  var host =
    root && root.window && root.window.__TAURI_INTERNALS__ ? root.window : root;
  var internals = host ? host.__TAURI_INTERNALS__ : undefined;

  // Tanpa bridge Tauri: jangan sentuh `Notification` apa pun.
  if (!internals || typeof internals.invoke !== "function") {
    return;
  }

  var IZIN_DEFAULT = "default";
  var IZIN_DIIZINKAN = "granted";
  var IZIN_DITOLAK = "denied";

  /** Status izin terakhir yang diketahui; "default" sampai dicek. */
  var izin = IZIN_DEFAULT;

  /**
   * Terjemahkan nilai izin dari plugin ke nilai izin Web.
   *
   * Plugin mengembalikan `true`/`false`/`null` (status izin) atau string
   * ("granted"/"denied"/"prompt"/"prompt-with-rationale") untuk permintaan
   * izin. Nilai lain jatuh ke "default".
   */
  function keIzinWeb(nilai) {
    if (nilai === true) return IZIN_DIIZINKAN;
    if (nilai === false) return IZIN_DITOLAK;
    if (nilai === IZIN_DIIZINKAN) return IZIN_DIIZINKAN;
    if (nilai === IZIN_DITOLAK) return IZIN_DITOLAK;
    return IZIN_DEFAULT;
  }

  /**
   * Panggil perintah plugin dan selalu jadi Promise.
   *
   * Galat tak pernah dilempar ke halaman; jadi Promise yang ditolak dan
   * pemanggil yang menentukan apa yang dilakukan.
   */
  function panggil(nama, argumen) {
    try {
      return Promise.resolve(
        argumen === undefined
          ? internals.invoke(nama)
          : internals.invoke(nama, argumen),
      );
    } catch (galat) {
      return Promise.reject(galat);
    }
  }

  /**
   * Kelas Notification versi Jejak.
   *
   * Properti `onclick` diterima tapi tak pernah dipanggil di desktop:
   * notifikasi native tak membawa aksi kembali ke webview.
   */
  function NotifikasiJejak(judul, opsi) {
    if (!(this instanceof NotifikasiJejak)) {
      return new NotifikasiJejak(judul, opsi);
    }
    var pilihan = opsi || {};
    this.title = judul == null ? "" : String(judul);
    this.body = pilihan.body == null ? "" : String(pilihan.body);
    this.tag = pilihan.tag == null ? "" : String(pilihan.tag);
    this.silent = pilihan.silent === true;
    this.onclick = null;

    panggil("plugin:notification|notify", {
      options: { title: this.title, body: this.body },
    }).catch(function () {
      // Notifikasi gagal: diamkan, jangan ganggu halaman.
    });
  }

  /** Tutup notifikasi; di desktop tak ada aksi yang perlu. */
  NotifikasiJejak.prototype.close = function () {};

  /** Minta izin notifikasi; mengembalikan "granted"/"denied"/"default". */
  NotifikasiJejak.requestPermission = function () {
    return panggil("plugin:notification|request_permission").then(
      function (hasil) {
        izin = keIzinWeb(hasil);
        return izin;
      },
      function () {
        izin = IZIN_DITOLAK;
        return izin;
      },
    );
  };

  Object.defineProperty(NotifikasiJejak, "permission", {
    configurable: true,
    enumerable: true,
    get: function () {
      return izin;
    },
    set: function (nilai) {
      izin = keIzinWeb(nilai);
    },
  });

  host.Notification = NotifikasiJejak;

  // Tanya status izin sekali saat skrip dimuat.
  panggil("plugin:notification|is_permission_granted").then(
    function (hasil) {
      izin = keIzinWeb(hasil);
    },
    function () {
      izin = IZIN_DITOLAK;
    },
  );
})();
