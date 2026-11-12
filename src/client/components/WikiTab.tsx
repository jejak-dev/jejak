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
import {
  filterRepos,
  gitlabProviders,
  matchRepos,
  readStoredProject,
  storedProjectErrorMessage,
  writeStoredProject,
  WIKI_PROJECT_STORAGE_KEY,
  type StoredWikiProject,
  type WikiProviderOption,
  type WikiRepo,
} from "../lib/wiki-project";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

export interface WikiState {
  /** Proyek wiki yang cocok dengan remote origin folder sesi. */
  project?: WikiProject;
  /** Proyek ini dipilih manual, bukan hasil pencocokan remote. */
  manual: boolean;
  /** Pemilih proyek manual ditampilkan. */
  picker: boolean;
  /** Penyedia GitLab yang bisa dipilih manual. */
  providers: readonly WikiProviderOption[];
  /** Penyedia yang sedang dipilih di pemilih proyek. */
  providerId?: string;
  /** Daftar repo penyedia yang sudah dimuat. */
  repos: readonly WikiRepo[];
  /** Saring nama repo di pemilih proyek. */
  repoQuery: string;
  /** Daftar repo sedang dimuat. */
  reposLoading: boolean;
  /** Galat memuat daftar repo. */
  reposError?: string;
  /** Daftar penyedia sedang dimuat. */
  providersLoading: boolean;
  /** Galat memuat daftar penyedia. */
  providersError?: string;
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
  /** Pilih penyedia GitLab di pemilih proyek. */
  onSelectProvider: (id: string) => void;
  /** Saring daftar repo di pemilih proyek. */
  onRepoQueryChange: (query: string) => void;
  /** Jadikan repo terpilih proyek wiki. */
  onPickRepo: (fullPath: string) => void;
  /** Muat ulang daftar repo. */
  onRetryRepos: () => void;
  /** Muat ulang daftar penyedia. */
  onRetryProviders: () => void;
  /** Buang pilihan tersimpan dan buka pemilih proyek. */
  onChangeProject: () => void;
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
  manual: false,
  picker: false,
  providers: [],
  repos: [],
  repoQuery: "",
  reposLoading: false,
  providersLoading: false,
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
 * Pemilih proyek manual: pilih penyedia GitLab, saring daftar repo, lalu
 * klik repo untuk dijadikan proyek wiki.
 */
function WikiProjectPicker({ state, actions }: { state: WikiState; actions: WikiActions }) {
  const visible = filterRepos(state.repos, state.repoQuery);
  const total = matchRepos(state.repos, state.repoQuery).length;

  return (
    <section class="jk-wiki-picker" aria-label="Pilih proyek wiki">
      <h3 class="jk-wiki-group-title">Pilih proyek wiki</h3>

      {state.providersLoading && (
        <p class="jk-panel-note" role="status">
          Memuat penyedia…
        </p>
      )}

      {state.providersError !== undefined && (
        <div class="jk-panel-error">
          <p class="jk-error-line" role="alert">
            {state.providersError}
          </p>
          <button
            type="button"
            class="jk-button jk-button-secondary"
            onClick={actions.onRetryProviders}
          >
            Coba lagi
          </button>
        </div>
      )}

      {!state.providersLoading &&
        state.providersError === undefined &&
        state.providers.length === 0 && (
          <p class="jk-note">
            Tidak ada penyedia GitLab. Tambahkan penyedia GitLab di halaman Workspace.
          </p>
        )}

      {state.providers.length > 0 && (
        <>
          <label class="jk-label" for="jk-wiki-provider">
            Penyedia GitLab
          </label>
          <select
            id="jk-wiki-provider"
            class="jk-select"
            value={state.providerId ?? ""}
            onChange={(event) =>
              actions.onSelectProvider((event.currentTarget as HTMLSelectElement).value)
            }
          >
            {state.providers.length > 1 && <option value="">Pilih penyedia…</option>}
            {state.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </>
      )}

      {state.providerId !== undefined && (
        <>
          {state.reposLoading && (
            <p class="jk-panel-note" role="status">
              Memuat daftar repo…
            </p>
          )}

          {state.reposError !== undefined && (
            <div class="jk-panel-error">
              <p class="jk-error-line" role="alert">
                {state.reposError}
              </p>
              <button
                type="button"
                class="jk-button jk-button-secondary"
                onClick={actions.onRetryRepos}
              >
                Coba lagi
              </button>
            </div>
          )}

          {!state.reposLoading && state.reposError === undefined && (
            <>
              <input
                class="jk-input jk-wiki-filter"
                type="search"
                value={state.repoQuery}
                placeholder="Saring repo"
                aria-label="Saring repo"
                onInput={(event) =>
                  actions.onRepoQueryChange((event.currentTarget as HTMLInputElement).value)
                }
              />
              {visible.length === 0 ? (
                <p class="jk-note">Tidak ada repo yang cocok.</p>
              ) : (
                <ul class="jk-wiki-list">
                  {visible.map((repo) => (
                    <li key={repo.fullPath}>
                      <button
                        type="button"
                        class="jk-wiki-page"
                        onClick={() => actions.onPickRepo(repo.fullPath)}
                      >
                        {repo.fullPath}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {total > visible.length && (
                <p class="jk-note">Persempit pencarian untuk melihat repo lainnya.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
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

      {state.picker && <WikiProjectPicker state={state} actions={actions} />}

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
          <div class="jk-wiki-head">
            <p class="jk-wiki-status">
              Proyek: {state.project.fullPath}
              {state.manual ? " (manual)" : ""}
            </p>
            {state.manual && (
              <button
                type="button"
                class="jk-link-btn"
                onClick={actions.onChangeProject}
              >
                Ganti proyek
              </button>
            )}
          </div>

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

/** Pilihan proyek tersimpan untuk folder; penyimpanan yang tidak terbaca berarti tidak ada. */
function readStored(cwd: string): StoredWikiProject | undefined {
  try {
    return readStoredProject(globalThis.localStorage.getItem(WIKI_PROJECT_STORAGE_KEY), cwd);
  } catch {
    return undefined;
  }
}

/** Simpan pilihan proyek untuk folder; kegagalan penyimpanan diabaikan. */
function saveStored(cwd: string, project: StoredWikiProject): void {
  try {
    const current = globalThis.localStorage.getItem(WIKI_PROJECT_STORAGE_KEY);
    globalThis.localStorage.setItem(
      WIKI_PROJECT_STORAGE_KEY,
      writeStoredProject(current, cwd, project),
    );
  } catch {
    // Penyimpanan tidak tersedia; pilihan hanya berlaku di sesi ini.
  }
}

/** Buang pilihan proyek untuk folder; kegagalan penyimpanan diabaikan. */
function forgetStored(cwd: string): void {
  try {
    const current = globalThis.localStorage.getItem(WIKI_PROJECT_STORAGE_KEY);
    globalThis.localStorage.setItem(
      WIKI_PROJECT_STORAGE_KEY,
      writeStoredProject(current, cwd, undefined),
    );
  } catch {
    // Penyimpanan tidak tersedia; tidak ada yang perlu dibuang.
  }
}

/**
 * Tab Wiki: daftar halaman wiki proyek GitLab yang terkait dengan folder
 * sesi, dibaca dari cache server dan disegarkan bila perlu.
 */
export function WikiTab({ api, cwd, onQuote }: WikiTabProps) {
  const [state, setState] = useState<WikiState>(INITIAL_STATE);

  const loadRepos = useCallback(
    async (providerId: string): Promise<void> => {
      setState((current) => ({
        ...current,
        providerId,
        reposLoading: true,
        reposError: undefined,
        repos: [],
        repoQuery: "",
      }));
      try {
        const repos = await api.listProviderRepos(providerId);
        setState((current) => ({
          ...current,
          reposLoading: false,
          repos: repos.map((repo) => ({ name: repo.name, fullPath: repo.fullPath })),
        }));
      } catch (caught) {
        const message = caught instanceof ApiError ? caught.message : undefined;
        setState((current) => ({
          ...current,
          reposLoading: false,
          reposError: message ?? "Gagal memuat daftar repo.",
        }));
      }
    },
    [api],
  );

  const openPicker = useCallback(async (): Promise<void> => {
    setState((current) => ({
      ...current,
      // Proyek lama dikosongkan agar daftar halamannya tidak tampil di bawah pemilih.
      project: undefined,
      manual: false,
      pages: [],
      sidebar: undefined,
      commit: undefined,
      fetchedAt: undefined,
      page: undefined,
      note: undefined,
      pageError: undefined,
      loading: false,
      syncing: false,
      picker: true,
      providersLoading: true,
      providersError: undefined,
      providers: [],
      providerId: undefined,
      repos: [],
      reposLoading: false,
      reposError: undefined,
      repoQuery: "",
    }));
    let options: WikiProviderOption[];
    try {
      options = gitlabProviders(await api.listGitProviders());
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : undefined;
      setState((current) => ({
        ...current,
        providersLoading: false,
        providersError: message ?? "Gagal memuat daftar penyedia git.",
      }));
      return;
    }
    if (options.length === 0) {
      // Tanpa penyedia GitLab tidak ada yang bisa dipilih: pesan lama saja.
      setState((current) => ({
        ...current,
        picker: false,
        providersLoading: false,
        providers: [],
        error: current.error ?? wikiErrorMessage(404),
        canRetry: false,
      }));
      return;
    }
    setState((current) => ({ ...current, providersLoading: false, providers: options }));
    const only = options.length === 1 ? options[0] : undefined;
    if (only !== undefined) await loadRepos(only.id);
  }, [api, loadRepos]);

  const applyProject = useCallback(
    async (project: WikiProject, manual: boolean, force: boolean): Promise<void> => {
      setState((current) => ({
        ...current,
        project,
        manual,
        loading: true,
        syncing: false,
        error: undefined,
        note: undefined,
        pageError: undefined,
      }));

      /** Pilihan tersimpan yang tidak berlaku lagi dibuang, lalu pemilih dibuka. */
      const fallback = async (status: number, message?: string): Promise<void> => {
        forgetStored(cwd);
        setState((current) => ({
          ...current,
          project: undefined,
          manual: false,
          pages: [],
          sidebar: undefined,
          commit: undefined,
          fetchedAt: undefined,
          loading: false,
          syncing: false,
          error: storedProjectErrorMessage(status, message),
          canRetry: false,
        }));
        await openPicker();
      };

      // Cache lama dipakai bila masih segar; selain itu wiki disinkronkan.
      let listing: WikiSync | undefined;
      try {
        listing = await api.wikiPages(project.providerId, project.fullPath);
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        if (status !== 409) {
          const message = caught instanceof ApiError ? caught.message : undefined;
          if (manual && status === 404) {
            await fallback(status, message);
            return;
          }
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
        if (manual && status === 404) {
          await fallback(status, message);
          return;
        }
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
    [api, cwd, openPicker],
  );

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
      let manual = false;
      try {
        project = await api.wikiProject(cwd);
      } catch (caught) {
        const status = caught instanceof ApiError ? caught.status : 0;
        if (status !== 404) {
          const message = caught instanceof ApiError ? caught.message : undefined;
          setState((current) => ({
            ...current,
            loading: false,
            error: wikiErrorMessage(status, message),
            canRetry: true,
          }));
          return;
        }
        // Pencocokan gagal: pakai pilihan proyek tersimpan bila ada.
        const stored = readStored(cwd);
        if (stored === undefined) {
          setState((current) => ({ ...current, loading: false }));
          await openPicker();
          return;
        }
        project = { providerId: stored.providerId, fullPath: stored.fullPath };
        manual = true;
      }

      await applyProject(project, manual, force);
    },
    [api, cwd, openPicker, applyProject],
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

  const pickRepo = useCallback(
    async (fullPath: string): Promise<void> => {
      const providerId = state.providerId;
      if (providerId === undefined) return;
      const project: WikiProject = { providerId, fullPath };
      saveStored(cwd, project);
      setState((current) => ({
        ...current,
        picker: false,
        providers: [],
        providerId: undefined,
        repos: [],
        repoQuery: "",
      }));
      await applyProject(project, true, false);
    },
    [cwd, state.providerId, applyProject],
  );

  const changeProject = useCallback((): void => {
    forgetStored(cwd);
    void openPicker();
  }, [cwd, openPicker]);

  const actions: WikiActions = {
    onRetry: () => void load(false),
    onRefresh: () => void load(true),
    onQueryChange: (query) => setState((current) => ({ ...current, query })),
    onOpenPage: (slug) => void openPage(slug),
    onClosePage: () => setState((current) => ({ ...current, page: undefined, pageError: undefined })),
    onQuote: quote,
    onLink: handleLink,
    onSelectProvider: (id) => {
      if (id === "") return;
      void loadRepos(id);
    },
    onRepoQueryChange: (query) => setState((current) => ({ ...current, repoQuery: query })),
    onPickRepo: (fullPath) => void pickRepo(fullPath),
    onRetryRepos: () => {
      const providerId = state.providerId;
      if (providerId !== undefined) void loadRepos(providerId);
    },
    onRetryProviders: () => void openPicker(),
    onChangeProject: changeProject,
  };

  return <WikiView state={state} actions={actions} canQuote={onQuote !== undefined} />;
}
