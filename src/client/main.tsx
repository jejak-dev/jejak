import "./styles.css";
import { render } from "preact";
import { App } from "./app";
import { registerServiceWorker } from "./lib/pwa";
import { applyTheme, loadTheme } from "./lib/theme";

// Pasang tema sebelum render agar tidak berkedip.
applyTheme(document.documentElement, loadTheme(safeStorage()));

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

render(<App />, document.getElementById("app")!);

// PWA: daftarkan service worker setelah halaman selesai dimuat.
registerServiceWorker();
