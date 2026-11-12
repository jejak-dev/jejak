import { useCallback, useEffect, useState } from "preact/hooks";
import { ApiError, type ApiClient } from "../lib/api";
import {
  buildTree,
  filterPages,
  freshness,
  quoteText,
  resolveWikiLink,
  wikiErrorMessage,
  type WikiNode,
  type WikiPage,
  type WikiPageRef,
  type WikiProject,
  type WikiSync,
} from "../lib/wiki";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export interface WikiState {
  /** Proyek wiki yang cocok dengan remote origin folder sesi. */
  project?: WikiProject;
  /** Daftar halaman dari cache server. */
  pages: readonly WikiPageRef[];
  /** Isi _Sidebar bila ada. */
  sidebar?: string;
  /** Commit cache terakhir. */
  commit?: string;
  /** Waktu pengambilan cache terakhir. */
  fetchedAt?: string;
  /** Cache dipakai karena sinkron gagal (kemungkinan tertinggal). */
  stale: boolean;
  /** Sedang memuat proyek atau daftar halaman. */
  loading: boolean;
  /** Sinkronisasi sedang berjalan. */
  syncing: boolean;
  /** Galat yang menghentikan pemuatan. */
  error?: string;
  /** Galat membuka halaman. */
  pageError?: string;
  /** Galat yang boleh dicoba ulang. */
  canRetry: boolean;
  /** Catatan tambahan (mis. galat sinkron). */
  note?: string;
  /** Saring judul halaman. */
  query: string;
  /** Halaman yang sedang dibuka. */
  page?: WikiPage;
  /** Halaman sedang dimuat. */
  pageLoading: boolean;
}

export interface WikiActions {
  onRetry: () => void;
  onRefresh: () => void;
  onQueryChange: (query: string) => void;
  onOpenPage: (slug: string) => void;
  onClosePage: () => void;
  onQuote: () => void;
  /** Intercept tautan di isi halaman; `true` berarti tautan ditangani. */
  onLink: (href: string) => boolean;
}

export interface WikiViewProps {
  state: WikiState;
  actions: WikiActions;
  /** Tombol kutip hanya tampil bila komposer menerima kutipan. */
  canQuote: boolean;
}

/** Judul grup dan halamannya, dari daftar datar hasil `buildTree`. */
interface WikiGroupView {
  title: string;
  items: WikiNode[];
}

const NO_FOLDER_MESSAGE = "Folder sesi belum tersedia.";
const EMPTY_MESSAGE = "Wiki ini belum punya halaman.";
const NO_MATCH_MESSAGE = "Tidak ada halaman yang cocok dengan saringan.";

const INITIAL_STATE: WikiState = {
  pages: [],
  stale: false,
  loading: true,
  syncing: false,
  canRetry: true,
  query: "",
  pageLoading: false,
};

/** Pisahkan daftar datar menjadi grup (judul grup + halamannya). */
function groupNodes(nodes: readonly WikiNode[]): WikiGroupView[] {
  const groups: WikiGroupView[] = [];
  let current: WikiGroupView | undefined;
  for (const node of nodes) {
    if (node.depth === 0) {
      current = { title: node.title, items: [] };
      groups.push(current);
      continue;
    }
    if (current === undefined) {
      current = { title: "", items: [] };
      groups.push(current);
    }
    current.items.push(node);
  }
  return groups;
}

/** Field daftar halaman dari respons server. */
function listingFields(listing: WikiSync): Partial<WikiState> {
  return {
    pages: listing.pages,
    sidebar: listing.sidebar,
    commit: listing.commit,
    fetchedAt: listing.fetchedAt,
  };
}

/**
 * Tampilan tab Wiki tanpa state internal; dipakai juga oleh tes (VNode
 * tanpa DOM). Isi wiki adalah data tak tepercaya: ditampilkan lewat
 * renderer markdown yang ada dan tidak pernah dikirim ke model.
 */
export function WikiView({ state, actions, canQuote }: WikiViewProps) {
  const pages = filterPages(state.pages, state.query);
  const groups = groupNodes(buildTree(pages, state.sidebar));

  if (state.page !== undefined) {
    const page = state.page;
    const fresh = freshness(page.fetchedAt, Date.now());
    return (
      <div class="jk-panel-body jk-wiki">
        <div class="jk-wiki-head">
          <button type="button" class="jk-link-btn" onClick={actions.onClosePage}>
            Kembali ke daftar
          </button>
          <button
            type="button"
            class="jk-icon-btn"
            aria-label="Segarkan wiki"
            onClick={actions.onRefresh}
          >
            <Icon name="refresh" />
          </button>
        </div>
        <h3 class="jk-wiki-title">{page.title}</h3>
        <p class="jk-wiki-status">
          commit {page.commit.slice(0, 7)} · {fresh.label}
        </p>
        {state.pageLoading && (
          <p class="jk-panel-note" role="status">
            Membuka halaman…
          </p>
        )}
        {page.truncated && <p class="jk-note">Halaman dipotong.</p>}
        {page.format === "markdown" ? (
          <Markdown text={page.content} onLink={actions.onLink} />
        ) : (
          <pre class="jk-wiki-pre">{page.content}</pre>
        )}
        {canQuote && (
          <button
            type="button"
            class="jk-button jk-button-secondary jk-wiki-quote"
            aria-label="Kutip ke komposer"
            onClick={actions.onQuote}
          >
            Kutip ke komposer
          </button>
        )}
      </div>
    );
  }

  const commit = state.commit === undefined ? "" : state.commit.slice(0, 7);
  const fresh = state.fetchedAt === undefined ? undefined : freshness(state.fetchedAt, Date.now());

  return (
    <div class="jk-panel-body jk-wiki">
      {state.error !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {state.error}
          </p>
          {state.canRetry && (
            <button
              type="button"
              class="jk-button jk-button-secondary"
              onClick={actions.onRetry}
            >
              Coba lagi
            </button>
          )}
        </div>
      )}

      {state.loading && (
        <p class="jk-panel-note" role="status">
          Memuat wiki…
        </p>
      )}

      {state.syncing && (
        <p class="jk-panel-note" role="status">
          Mengambil wiki…
        </p>
      )}

      {state.note !== undefined && (
        <p class="jk-note" role="alert">
          {state.note}
        </p>
      )}

      {state.pageError !== undefined && (
        <p class="jk-note" role="alert">
          {state.pageError}
        </p>
      )}

      {state.pageLoading && (
        <p class="jk-panel-note" role="status">
          Membuka halaman…
        </p>
      )}

      {state.project !== undefined && (
        <>
          <div class="jk-wiki-toolbar">
            <input
              class="jk-input jk-wiki-filter"
              type="search"
              value={state.query}
              placeholder="Saring judul"
              aria-label="Saring judul halaman"
              onInput={(event) =>
                actions.onQueryChange((event.currentTarget as HTMLInputElement).value)
              }
            />
            <button
              type="button"
              class="jk-icon-btn"
              aria-label="Segarkan wiki"
              onClick={actions.onRefresh}
            >
              <Icon name="refresh" />
            </button>
          </div>

          <p class="jk-wiki-status">
            commit {commit}
            {fresh !== undefined ? ` · ${fresh.label}` : ""}
            {state.stale ? " · mungkin tertinggal" : ""}
          </p>

          {state.pages.length === 0 ? (
            <p class="jk-panel-note">{EMPTY_MESSAGE}</p>
          ) : groups.length === 0 ? (
            <p class="jk-panel-note">{NO_MATCH_MESSAGE}</p>
          ) : (
            groups.map((group) => (
              <section class="jk-wiki-group" key={group.title}>
                <h3 class="jk-wiki-group-title">{group.title}</h3>
                <ul class="jk-wiki-list">
                  {group.items.map((item) => (
                    <li key={item.slug}>
                      <button
                        type="button"
                        class="jk-wiki-page"
                        onClick={() => actions.onOpenPage(item.slug)}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
}

export interface WikiTabProps {
  api: ApiClient;
  /** Folder kerja sesi; wiki diambil dari remote origin folder ini. */
  cwd: string;
  /** Dipanggil untuk menempelkan kutipan halaman ke komposer. */
  onQuote?: (text: string) => void;
}

/**
 * Tab Wiki: daftar halaman wiki proyek GitLab yang terkait dengan folder
 * sesi, dibaca dari cache server dan disegarkan bila perlu.
 */
export function WikiTab({ api, cwd, onQuote }: WikiTabProps) {
  const [state, setState] = useState<WikiState>(INITIAL_STATE);

  const load = useCallback(
    async (force: boolean): Promise<void> => {
      if (cwd === "") {
        setState({
          ...INITIAL_STATE,
          loading: false,
          error: NO_FOLDER_MESSAGE,
          canRetry: false,
        });
        return;
      }
      setState((current) => ({
        ...current,
        loading: true,
        syncing: false,
        error: undefined,
        note: undefined,
        pageError: undefined,
      }));

      let project: WikiProject;
      try {
        project = await api.wikiProject(cwd);
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        const message = caught instanceof ApiError ? caught.message : undefined;
        setState((current) => ({
          ...current,
          loading: false,
          error: wikiErrorMessage(status, message),
          // Tanpa proyek tidak ada yang bisa dicoba ulang.
          canRetry: status !== 404,
        }));
        return;
      }
      setState((current) => ({ ...current, project }));

      // Cache lama dipakai bila masih segar; selain itu wiki disinkronkan.
      let listing: WikiSync | undefined;
      try {
        listing = await api.wikiPages(project.providerId, project.fullPath);
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        if (status !== 409) {
          const message = caught instanceof ApiError ? caught.message : undefined;
          setState((current) => ({
            ...current,
            loading: false,
            error: wikiErrorMessage(status, message),
          }));
          return;
        }
      }

      const stale = listing === undefined || freshness(listing.fetchedAt, Date.now()).stale;
      if (!force && listing !== undefined && !stale) {
        setState((current) => ({
          ...current,
          ...listingFields(listing),
          loading: false,
          syncing: false,
          stale: false,
        }));
        return;
      }

      setState((current) => ({ ...current, loading: false, syncing: true }));
      try {
        const fresh = await api.wikiSync(project.providerId, project.fullPath);
        setState((current) => ({
          ...current,
          ...listingFields(fresh),
          loading: false,
          syncing: false,
          stale: false,
          note: undefined,
        }));
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        const message = caught instanceof ApiError ? caught.message : undefined;
        if (listing !== undefined) {
          // Sinkron gagal: pakai cache lama dan tandai mungkin tertinggal.
          setState((current) => ({
            ...current,
            ...listingFields(listing),
            loading: false,
            syncing: false,
            stale: true,
            note: wikiErrorMessage(status, message),
          }));
        } else {
          setState((current) => ({
            ...current,
            loading: false,
            syncing: false,
            error: wikiErrorMessage(status, message),
          }));
        }
      }
    },
    [api, cwd],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const openPage = useCallback(
    async (slug: string): Promise<void> => {
      const project = state.project;
      if (project === undefined) return;
      setState((current) => ({ ...current, pageLoading: true, pageError: undefined }));
      try {
        const page = await api.wikiPage(project.providerId, project.fullPath, slug);
        setState((current) => ({ ...current, pageLoading: false, page }));
      } catch (caught) {
        const message = caught instanceof ApiError ? caught.message : undefined;
        setState((current) => ({
          ...current,
          pageLoading: false,
          pageError: message ?? "Halaman wiki tidak dapat dibaca.",
        }));
      }
    },
    [api, state.project],
  );

  const quote = useCallback((): void => {
    const page = state.page;
    const project = state.project;
    if (page === undefined || project === undefined) return;
    onQuote?.(
      quoteText({
        slug: page.slug,
        title: page.title,
        content: page.content,
        commit: page.commit,
        fetchedAt: page.fetchedAt,
        source: project.fullPath,
      }),
    );
  }, [onQuote, state.page, state.project]);

  const handleLink = useCallback(
    (href: string): boolean => {
      const current = state.page?.slug ?? "";
      const resolved = resolveWikiLink(href, current, state.pages);
      if (resolved.kind === "wiki") {
        void openPage(resolved.slug);
        return true;
      }
      // Tautan tak dikenal ditahan agar panel tidak navigated keluar.
      return resolved.kind !== "external";
    },
    [openPage, state.page, state.pages],
  );

  const actions: WikiActions = {
    onRetry: () => void load(false),
    onRefresh: () => void load(true),
    onQueryChange: (query) => setState((current) => ({ ...current, query })),
    onOpenPage: (slug) => void openPage(slug),
    onClosePage: () => setState((current) => ({ ...current, page: undefined, pageError: undefined })),
    onQuote: quote,
    onLink: handleLink,
  };

  return <WikiView state={state} actions={actions} canQuote={onQuote !== undefined} />;
}
