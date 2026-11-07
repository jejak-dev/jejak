import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import type { SessionInfo } from "../server/sessions/session-manager";
import { Composer } from "./components/Composer";
import { SessionHeader } from "./components/SessionHeader";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { useHashRoute, useInfo, useRegistry, useSessions, useTimeline } from "./hooks";
import { createApiClient } from "./lib/api";

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const [selectedId, navigate] = useHashRoute();
  const { info } = useInfo(api);
  const { sessions, refresh } = useSessions(api);
  const { view } = useRegistry(api);

  const selected = sessions.find((session) => session.id === selectedId);
  const timeline = useTimeline(api, selected);

  const [interruptError, setInterruptError] = useState<string | undefined>(undefined);
  const [interrupting, setInterrupting] = useState(false);

  const activeProfile = view?.profiles.find((profile) => profile.id === view.activeProfileId);
  const activeProfileLabel = activeProfile?.name ?? view?.activeProfileId;

  useEffect(() => {
    document.title = selected !== undefined ? `${selected.title} · Jejak` : "Jejak";
  }, [selected]);

  const onSelect = useCallback(
    (id: string): void => {
      navigate(id);
    },
    [navigate],
  );

  const onNew = useCallback((): void => {
    navigate();
  }, [navigate]);

  const onCreated = useCallback(
    (session: SessionInfo): void => {
      void (async () => {
        await refresh();
        navigate(session.id);
      })();
    },
    [navigate, refresh],
  );

  const interruptId = selected?.id;
  const onInterrupt = useCallback((): void => {
    if (interruptId === undefined) return;
    setInterrupting(true);
    setInterruptError(undefined);
    void (async () => {
      try {
        await api.interruptSession(interruptId);
        await refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "gagal menghentikan sesi";
        setInterruptError(message);
      } finally {
        setInterrupting(false);
      }
    })();
  }, [api, interruptId, refresh]);

  const headerError = selected !== undefined ? interruptError : undefined;

  return (
    <div class="jk-app">
      <Sidebar
        info={info}
        sessions={sessions}
        selectedId={selectedId}
        onSelect={onSelect}
        onNew={onNew}
        activeProfileLabel={activeProfileLabel}
      />

      <main class="jk-main">
        {selected !== undefined ? (
          <>
            <SessionHeader
              session={selected}
              status={timeline.status ?? selected.status}
              onInterrupt={onInterrupt}
              busy={interrupting}
              error={headerError}
            />
            <Timeline items={timeline.items} connection={timeline.connection} />
          </>
        ) : (
          <section class="jk-empty-state" aria-labelledby="jk-empty-title">
            <h2 id="jk-empty-title">Mulai sesi pertamamu</h2>
            <p>Tulis tugas, pilih folder kerja, lalu mulai sesi untuk melihat jejaknya di sini.</p>
          </section>
        )}

        <Composer api={api} defaultCwd={info?.cwd} registry={view} onCreated={onCreated} />
      </main>
    </div>
  );
}
