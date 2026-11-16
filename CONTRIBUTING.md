# Contributing to Jejak

Thanks for taking the time. Jejak is young, so small, well-scoped pull requests are
much easier to review than large ones.

## Setup

Requirements:

- Bun 1.4 or newer
- Node.js is not required
- Rust (stable toolchain) only if you want to build the Tauri desktop shell

```bash
bun install
bun run doctor     # checks the environment and reports what is missing
bun run start      # server on http://127.0.0.1:3000
bun run dev        # same, with hot reload
```

`bun run doctor` also tells you whether the optional agent SDK is present. The server
runs with the mock agent (`--mock`) when it is not.

## Checks

Run both before you open a pull request:

```bash
bun run typecheck   # tsc --noEmit
bun test            # test suite
```

CI runs the same two commands on macOS and Windows, plus `bun run check:version` and
the Rust checks for `src-tauri` (`cargo test`, `cargo clippy --all-targets -- -D
warnings`). See [.github/README-CI.md](.github/README-CI.md) for the details.

## Browser tests (end-to-end)

The unit suite above runs in-process; a few flows can only be checked in a real
browser (the composer, the right-hand panel, scheduled tasks, held prompts).
Those specs live in `tests/e2e/specs/` and run under Playwright:

```bash
bunx playwright install chromium   # once per machine, downloads the browser
bun run test:e2e                   # starts a mock server on 127.0.0.1:3931
```

The e2e server uses the mock agent and a temporary `JEJAK_HOME`, so it never
calls a real model and never touches `~/.jejak`. Spec files use the `.e2e.ts`
suffix on purpose: `bun test` globs `*.spec.ts` as well, and the two runners
must not pick up each other's files.

## Conventions

The rules live in [AGENTS.md](AGENTS.md); the short version:

- TypeScript strict. Bun is the runtime, not Node.
- **One change per commit.** A commit that does two things is two commits.
- **Every behavior change comes with a test.** Tests live in `tests/`.
- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `test:`, `chore:`. Write the
  subject in Indonesian, matching the existing history.
- **Do not add a dependency without a clear reason**, stated in the description of the
  change.
- **No secrets** (keys, tokens, credentials) in the repository, in logs, or in chat.
- The server binds `127.0.0.1` by default. Do not make it reachable without
  authentication.
- Access to databases and external brokers is read-only unless there is a written
  decision otherwise.
- Memory and notes must record their source (file, commit, date) and a confidence
  level.

## Desktop shell (Tauri)

The desktop app is a Tauri shell around the same server binary. Building it needs a
Rust toolchain:

```bash
bun run build:desktop
```

That script builds the sidecar binary, places it where Tauri expects it
(`src-tauri/binaries/`), and runs `tauri build`. On macOS the result is an `.app` and
a `.dmg`; on Windows it is an NSIS installer.

Useful related scripts:

```bash
bun run build:binary   # build the server binary for the current platform
bun run stage:sidecar  # copy the binary into src-tauri/binaries/
bun run smoke:binary   # smoke-test a built binary
```

## Pull request checklist

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes (add a test for any behavior change)
- [ ] `CHANGELOG.md` updated if the change is user-visible
- [ ] Conventional Commit message, one change per commit
- [ ] No secrets, no personal paths, no unrelated reformatting
- [ ] New dependencies (if any) are justified in the description
- [ ] Documentation updated (README, or the relevant module comment)

## Reporting bugs

Use the bug report template on GitHub. If you find a security problem, do **not**
open a public issue — follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the MIT
license of this repository.
