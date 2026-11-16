import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  type ApiClient,
  type MarketplaceInfoItem,
  type MarketplacePluginItem,
} from "../lib/api";
import { installConfirmText, marketplaceSourceNote, searchPageLabel } from "../lib/plugins";
import { Select } from "./Select";

/** Pesan yang sama dengan halaman Instruksi saat pengaturan Claude dimatikan. */
export const DISABLED_NOTE = "Pengaturan Claude dimatikan (JEJAK_CLAUDE_CONFIG=0).";

/** Jumlah plugin per halaman katalog. */
const PAGE_LIMIT = 50;
/** Tunggu sesaat sebelum pencarian dijalankan; menahan ketikan. */
const DEBOUNCE_MS = 300;

const EMPTY_NOTE = "Tak ada plugin yang cocok.";
const NO_MARKETPLACE_NOTE =
  "Belum ada marketplace yang dikonfigurasi. Tambahkan lewat terminal: claude plugin marketplace add <sumber>, lalu muat ulang.";
const INSTALL_OK_NOTE = "Terpasang. Nyalakan di tab Terpasang agar dipakai sesi berikutnya.";
const INSTALLING_NOTE = "Memasang… (bisa sampai beberapa menit)";
const UNINSTALLING_NOTE = "Mencabut…";
const UNINSTALL_OK_NOTE = "Plugin dicopot dari Claude Code.";

/** Status satu kartu: info saat berjalan, hijau saat berhasil, galat saat gagal. */
interface StatusPesan {
  nada: "info" | "ok" | "galat";
  teks: string;
}

/** Konfirmasi yang sedang terbuka di dalam kartu. */
interface Konfirmasi {
  id: string;
  mode: "pasang" | "copot";
}

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  if (caught instanceof Error && caught.message !== "") return caught.message;
  return "plugin tidak dapat dimuat";
}

function isDisabled(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 503;
}

export interface PluginBrowserProps {
  api: ApiClient;
  /** Dipanggil setelah pemasangan atau pencabutan agar daftar terpasang disegarkan. */
  onChanged?: () => void;
}

/**
 * Penjelajahan katalog marketplace.
 *
 * Pemasangan berarti mengunduh kode pihak ketiga, jadi tiap pemasangan
 * meminta konfirmasi eksplisit dan hanya satu yang boleh berjalan.
 */
export function PluginBrowser({ api, onChanged }: PluginBrowserProps) {
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfoItem[]>([]);
  const [items, setItems] = useState<MarketplacePluginItem[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  /** Teks yang diketik pengguna. */
  const [queryInput, setQueryInput] = useState("");
  /** Teks pencarian yang sudah dipakai (setelah jeda). */
  const [query, setQuery] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [category, setCategory] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [disabled, setDisabled] = useState(false);
  const [konfirmasi, setKonfirmasi] = useState<Konfirmasi | undefined>();
  const [status, setStatus] = useState<Record<string, StatusPesan>>({});
  /** Id plugin yang sedang dipasang atau dicabut; hanya satu yang boleh jalan. */
  const [sedang, setSedang] = useState<string | undefined>();
  /** Penanda permintaan pencarian yang sedang berjalan. */
  const reqRef = useRef(0);
  /** Timer jeda pencarian. */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Penjaga: hanya satu pemasangan atau pencabutan yang boleh berjalan. */
  const sibukRef = useRef(false);
  /** Makin banyak untuk memuat ulang data. */
  const [muatUlang, setMuatUlang] = useState(0);

  // Jeda pencarian: ketikan cepat tak memicu permintaan bertubi-tubi.
  useEffect(() => {
    if (queryInput === query) return;
    const timer = setTimeout(() => {
      timerRef.current = undefined;
      setQuery(queryInput);
      setOffset(0);
    }, DEBOUNCE_MS);
    timerRef.current = timer;
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [queryInput, query]);

  // Daftar marketplace; sekaligi dimuat ulang tiap permintaan muat ulang.
  useEffect(() => {
    let batal = false;
    api
      .listMarketplaces()
      .then((daftar) => {
        if (batal) return;
        setMarketplaces(daftar);
      })
      .catch((caught: unknown) => {
        if (batal) return;
        if (isDisabled(caught)) {
          setDisabled(true);
          setError(undefined);
        } else {
          setError(errorMessage(caught));
        }
      });
    return () => {
      batal = true;
    };
  }, [api, muatUlang]);

  // Pencarian katalog; permintaan lama dibuang lewat reqRef.
  useEffect(() => {
    const ticket = reqRef.current + 1;
    reqRef.current = ticket;
    setLoading(true);
    setError(undefined);
    api
      .searchMarketplace({
        query,
        marketplace,
        category,
        limit: PAGE_LIMIT,
        offset,
      })
      .then((hasil) => {
        if (ticket !== reqRef.current) return;
        setItems(hasil.items);
        setTotal(hasil.total);
        setCategories(hasil.categories);
      })
      .catch((caught: unknown) => {
        if (ticket !== reqRef.current) return;
        setItems([]);
        setTotal(0);
        if (isDisabled(caught)) {
          setDisabled(true);
          setError(undefined);
        } else {
          setError(errorMessage(caught));
        }
      })
      .finally(() => {
        if (ticket === reqRef.current) setLoading(false);
      });
  }, [api, query, marketplace, category, offset, muatUlang]);

  const pasang = useCallback(
    async (plugin: MarketplacePluginItem): Promise<void> => {
      if (sibukRef.current) return;
      sibukRef.current = true;
      setKonfirmasi(undefined);
      setSedang(plugin.id);
      setStatus((current) => ({
        ...current,
        [plugin.id]: { nada: "info", teks: INSTALLING_NOTE },
      }));
      try {
        const hasil = await api.installPlugin(plugin.id);
        if (hasil.ok) {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "ok", teks: INSTALL_OK_NOTE },
          }));
          setItems((current) =>
            current.map((item) =>
              item.id === plugin.id ? { ...item, installed: true } : item,
            ),
          );
          onChanged?.();
        } else {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "galat", teks: hasil.message },
          }));
        }
      } catch (caught) {
        if (isDisabled(caught)) {
          setDisabled(true);
          setError(undefined);
        } else {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "galat", teks: errorMessage(caught) },
          }));
        }
      } finally {
        sibukRef.current = false;
        setSedang(undefined);
      }
    },
    [api, onChanged],
  );

  const copot = useCallback(
    async (plugin: MarketplacePluginItem): Promise<void> => {
      if (sibukRef.current) return;
      sibukRef.current = true;
      setKonfirmasi(undefined);
      setSedang(plugin.id);
      setStatus((current) => ({
        ...current,
        [plugin.id]: { nada: "info", teks: UNINSTALLING_NOTE },
      }));
      try {
        const hasil = await api.uninstallPlugin(plugin.id);
        if (hasil.ok) {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "ok", teks: UNINSTALL_OK_NOTE },
          }));
          setItems((current) =>
            current.map((item) =>
              item.id === plugin.id ? { ...item, installed: false } : item,
            ),
          );
          onChanged?.();
        } else {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "galat", teks: hasil.message },
          }));
        }
      } catch (caught) {
        if (isDisabled(caught)) {
          setDisabled(true);
          setError(undefined);
        } else {
          setStatus((current) => ({
            ...current,
            [plugin.id]: { nada: "galat", teks: errorMessage(caught) },
          }));
        }
      } finally {
        sibukRef.current = false;
        setSedang(undefined);
      }
    },
    [api, onChanged],
  );

  if (disabled) {
    return <p class="jk-note">{DISABLED_NOTE}</p>;
  }

  const adaMarketplace = marketplaces.length > 0;
  const adaKategori = categories.length > 0;

  return (
    <div class="jk-plugin-browser">
      <div class="jk-plugin-toolbar">
        <input
          type="search"
          class="jk-input jk-plugin-search"
          placeholder="Cari plugin…"
          aria-label="Cari plugin di marketplace"
          maxLength={100}
          value={queryInput}
          onInput={(event) =>
            setQueryInput((event.currentTarget as HTMLInputElement).value)
          }
        />
        {marketplaces.length > 1 && (
          <Select
            class="jk-plugin-filter"
            size="compact"
            ariaLabel="Marketplace"
            value={marketplace}
            options={[
              { value: "", label: "Semua marketplace" },
              ...marketplaces.map((item) => ({ value: item.name, label: item.name })),
            ]}
            onChange={(value) => {
              setMarketplace(value);
              setOffset(0);
            }}
          />
        )}
        {adaKategori && (
          <Select
            class="jk-plugin-filter"
            size="compact"
            ariaLabel="Kategori"
            value={category}
            options={[
              { value: "", label: "Semua kategori" },
              ...categories.map((item) => ({ value: item, label: item })),
            ]}
            onChange={(value) => {
              setCategory(value);
              setOffset(0);
            }}
          />
        )}
      </div>

      {loading && (
        <p class="jk-note" role="status" aria-live="polite">
          Memuat…
        </p>
      )}

      {!loading && error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {error}
          </p>
          <button
            type="button"
            class="jk-link-btn"
            onClick={() => setMuatUlang((current) => current + 1)}
          >
            Coba lagi
          </button>
        </div>
      )}

      {!loading && error === undefined && !adaMarketplace && (
        <div class="jk-plugin-empty">
          <p class="jk-note">{NO_MARKETPLACE_NOTE}</p>
          <button
            type="button"
            class="jk-link-btn"
            onClick={() => setMuatUlang((current) => current + 1)}
          >
            Muat ulang
          </button>
        </div>
      )}

      {!loading && error === undefined && adaMarketplace && total === 0 && (
        <p class="jk-note">{EMPTY_NOTE}</p>
      )}

      {!loading && error === undefined && items.length > 0 && (
        <ul class="jk-plugin-list">
          {items.map((plugin) => {
            const nama = plugin.displayName !== "" ? plugin.displayName : plugin.name;
            const statusPlugin = status[plugin.id];
            const sedangPasang = sedang === plugin.id;
            const terkunci = sedang !== undefined;
            return (
              <li class="jk-plugin-card jk-plugin-market-card" key={plugin.id}>
                <div class="jk-plugin-head">
                  <span class="jk-plugin-name">{nama}</span>
                  {plugin.version !== "" && (
                    <span class="jk-badge jk-badge-muted">{plugin.version}</span>
                  )}
                  <span class="jk-badge jk-badge-muted">{plugin.marketplace}</span>
                </div>

                {plugin.category !== "" && (
                  <span class="jk-plugin-category">{plugin.category}</span>
                )}

                {plugin.description !== "" && (
                  <p class="jk-plugin-desc" title={plugin.description}>
                    {plugin.description}
                  </p>
                )}

                <div class="jk-plugin-meta">
                  {plugin.author !== "" && (
                    <span class="jk-plugin-author">{plugin.author}</span>
                  )}
                  {plugin.homepage !== "" && (
                    <a
                      class="jk-plugin-link"
                      href={plugin.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Beranda
                    </a>
                  )}
                </div>

                <p
                  class={
                    plugin.sourceKind === "command"
                      ? "jk-plugin-warn"
                      : "jk-plugin-source"
                  }
                >
                  {marketplaceSourceNote(plugin.sourceKind)}
                </p>

                <div class="jk-plugin-actions">
                  {plugin.installed ? (
                    <>
                      <button type="button" class="jk-button" disabled={terkunci}>
                        Terpasang
                      </button>
                      <button
                        type="button"
                        class="jk-button"
                        disabled={terkunci}
                        onClick={() => setKonfirmasi({ id: plugin.id, mode: "copot" })}
                      >
                        Copot
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      class="jk-button jk-button-primary"
                      disabled={terkunci}
                      onClick={() => setKonfirmasi({ id: plugin.id, mode: "pasang" })}
                    >
                      {sedangPasang ? "Memasang…" : "Pasang"}
                    </button>
                  )}
                </div>

                {konfirmasi?.id === plugin.id && (
                  <div class="jk-plugin-confirm">
                    <p class="jk-plugin-confirm-text">
                      {konfirmasi.mode === "pasang"
                        ? installConfirmText(plugin)
                        : `Copot ${nama} (${plugin.marketplace}) dari Claude Code?`}
                    </p>
                    <div class="jk-plugin-confirm-actions">
                      <button
                        type="button"
                        class="jk-button jk-button-primary"
                        onClick={() =>
                          void (konfirmasi.mode === "pasang" ? pasang(plugin) : copot(plugin))
                        }
                      >
                        {konfirmasi.mode === "pasang" ? "Ya, pasang" : "Ya, copot"}
                      </button>
                      <button
                        type="button"
                        class="jk-button"
                        onClick={() => setKonfirmasi(undefined)}
                      >
                        Batal
                      </button>
                    </div>
                  </div>
                )}

                {statusPlugin !== undefined && (
                  <p
                    class={
                      statusPlugin.nada === "galat"
                        ? "jk-error-line"
                        : statusPlugin.nada === "ok"
                          ? "jk-plugin-ok"
                          : "jk-plugin-info"
                    }
                    role={statusPlugin.nada === "galat" ? "alert" : undefined}
                  >
                    {statusPlugin.teks}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && error === undefined && total > 0 && (
        <div class="jk-plugin-pager">
          <button
            type="button"
            class="jk-button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(offset - PAGE_LIMIT, 0))}
          >
            Sebelumnya
          </button>
          <span class="jk-plugin-pager-label">
            {searchPageLabel(offset, PAGE_LIMIT, total)}
          </span>
          <button
            type="button"
            class="jk-button"
            disabled={offset + PAGE_LIMIT >= total}
            onClick={() => setOffset(offset + PAGE_LIMIT)}
          >
            Berikutnya
          </button>
        </div>
      )}
    </div>
  );
}
