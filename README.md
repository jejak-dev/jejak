# Jejak

A model-agnostic workbench for coding agents, with **cross-repo memory**: the agent
knows which services, database tables, and queues connect to each other, and can
estimate the blast radius of a change before touching code.

> Status: early stage (v0.0.1). The project is young and the interfaces are still
> moving.

[Bahasa Indonesia](README.id.md)

## What it does

Jejak is a local-first desktop app. It runs a small HTTP/WebSocket server on your
machine, an agent drives it, and you watch the work in a timeline.

- **Sessions and streaming** — parallel sessions, ordered event buffer, SSE
  streaming, SQLite persistence, reconnect, and conversation rewind.
- **Git and worktrees** — an isolated worktree per session with status, staging,
  draft commits, history, delete, and restore.
- **Files and changes** — folder browser, file editor, text search, per-hunk diffs,
  and the ability to reject or reorder hunks before applying.
- **Memory in two layers** — Markdown files on disk as the source of truth, a Memory
  page in the UI, and an MCP bridge (`memory_search`, `memory_propose`).
- **Multi-repo workspace** — a workspace list, extra repositories per session, and a
  service overview the agent can read.
- **MCP servers** — external and internal servers, connection tests, and attaching a
  server to a session.
- **Indexing** — a GitLab indexer and a local-folder indexer, both read-only, with
  indexing tools and an indexing screen.
- **Goal mode** — the `/goal` command with a turn limit, timeline markers, and
  notifications when the goal is reached.
- **Project commands** — package scripts and custom commands with hash confirmation,
  a Commands tab, and a PTY terminal.
- **Safety rails** — per-tool permission modes, a bypass mode with a kill switch, a
  directed Bash sandbox, secret-file access blocking, and an append-only audit log
  that redacts secrets.
- **Cost and usage** — a usage page, budgets, a context-window view per model with
  per-model rates and cost estimates, and switchable providers and models.
- **Extras** — voice dictation with privacy consent, an installable PWA, a GitLab
  Wiki tab, and in-app updates.

## Requirements

- For the desktop app: macOS 12 or newer, or Windows x64 (Windows is still beta).
- For running from source: Bun 1.4 or newer.

## Install the desktop app

On macOS, one line installs `Jejak.app` into `~/Applications` (no `sudo` needed):

```bash
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh
```

You can also drag `Jejak.app` out of the `.dmg` into Applications. On Windows,
download the `.exe` from [GitHub Releases](https://github.com/jejak-dev/jejak/releases).
Builds are published for macOS (Apple silicon and Intel) and Windows (x64).

Two honest caveats, because the app is **not signed with an OS vendor certificate**:

- **macOS**: Gatekeeper shows an "unidentified developer" / "app is from an
  unidentified developer" warning. Open it with right-click → **Open**, or go to
  **System Settings → Privacy & Security → Open Anyway**.
- **Windows**: SmartScreen shows "Windows protected your PC". Choose **More info →
  Run anyway**. Windows builds are marked **beta**.

Updates are delivered by the app itself. Each update is signed with a minisign key
whose public key is pinned in the application, so a tampered bundle will not install.

Full steps, data locations, troubleshooting, and uninstall instructions:
[INSTALL.md](INSTALL.md).

## Run from source

```bash
bun install
bun run doctor     # check the environment
bun run start      # run the server on http://127.0.0.1:3000
```

`bun run dev` starts the server with hot reload. `bun run typecheck` and `bun test`
run the checks used by CI.

### CLI

After `bun link`, the `jejak` command is available:

```bash
jejak doctor                    # check the environment
jejak serve                     # run the server (default 127.0.0.1:3000)
jejak serve --port 3001         # or --port=3001
jejak serve --host 127.0.0.1    # bind address
jejak serve --mock              # mock agent, no SDK required
jejak --version
jejak --help
```

Useful flags and environment variables:

- `--password auto` / `--password-file <path>` / `JEJAK_PASSWORD` — protect the
  server with a single password.
- A password you set yourself in Settings → *Access & password* is stored as a
  scrypt hash in `~/.jejak/auth.json` (mode `600`) and is used automatically by
  `jejak serve` when no password flag or environment variable is given.
- `--allow-host <host>` — add an allowed `Host` header (repeatable).
- `--insecure-no-auth` — allow a non-loopback bind without a password (risky).
- `--tls-cert <path> --tls-key <path>` — serve HTTPS with your own certificate.
- `HOST`, `PORT` — bind address and port (default `127.0.0.1:3000`).
- `JEJAK_HOME` — data folder (default `~/.jejak`).
- `JEJAK_PROMPT_SUGGESTION=0` — turn off the prompt suggestion shown after each
  turn (on by default).

## Security

- The server listens on `127.0.0.1` by default and refuses a non-loopback bind
  unless a password is set (or you pass `--insecure-no-auth`).
- API requests are checked against an allowlist of `Host` and `Origin` values, so a
  page in your browser cannot drive the server from another origin.
- Data lives in `~/.jejak` (override with `JEJAK_HOME`). Provider API keys are
  written with file mode `600`; they are **not** encrypted at rest. You can instead
  point a provider at an environment variable.
- The agent runs shell commands. Permissions are per tool, the Bash tool can be
  sandboxed, and known secret files (`.env`, `*.pem`, `~/.ssh/**`, `.aws/credentials`,
  …) are blocked from being read.
- Secrets are redacted from the audit log and the event stream.

See [SECURITY.md](SECURITY.md) for the threat model and how to report a
vulnerability.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). The short
version: one change per commit, Conventional Commits, a test with every behavior
change, and no secrets in the repository.

## License

[MIT](LICENSE)
