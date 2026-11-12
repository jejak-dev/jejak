import { useEffect, useState } from "preact/hooks";
import { formatRetry } from "../lib/auth";

export interface LoginScreenProps {
  /** Pesan galat dari server (mis. "sandi salah"). */
  error?: string;
  /** Detik penundaan tersisa; tombol masuk dinonaktifkan selama hitungan. */
  retryAfterSec?: number;
  /** Aksi masuk; selesai ketika server menerima kata sandi. */
  onLogin: (password: string) => Promise<void>;
}

/** Layar login minimal: satu kolom sandi, tombol Masuk, pesan galat, hitung mundur. */
export function LoginScreen({ error, retryAfterSec, onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState(retryAfterSec ?? 0);

  useEffect(() => {
    setRemaining(retryAfterSec ?? 0);
  }, [retryAfterSec]);

  // Hitung mundur penundaan login.
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => {
      setRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  const submit = async (): Promise<void> => {
    if (busy || remaining > 0 || password === "") return;
    setBusy(true);
    try {
      await onLogin(password);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  const blocked = remaining > 0;

  return (
    <div class="jk-login">
      <form
        class="jk-login-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h1 class="jk-login-title">Jejak</h1>
        <p class="jk-login-sub">Masukkan kata sandi untuk melanjutkan.</p>
        <label class="jk-visually-hidden" for="jk-login-password">
          Kata sandi
        </label>
        <input
          id="jk-login-password"
          class="jk-input jk-login-input"
          type="password"
          value={password}
          autoComplete="current-password"
          autoFocus
          disabled={busy}
          aria-invalid={error !== undefined}
          onInput={(event) => setPassword((event.currentTarget as HTMLInputElement).value)}
        />
        <button
          type="submit"
          class="jk-button jk-button-primary jk-login-button"
          disabled={busy || blocked || password === ""}
        >
          {busy ? "Memeriksa…" : "Masuk"}
        </button>
        {error !== undefined && (
          <p class="jk-error-line jk-login-error" role="alert">
            {error}
          </p>
        )}
        {blocked && <p class="jk-login-retry">{formatRetry(remaining)}</p>}
      </form>
    </div>
  );
}
