# Security Policy

## Supported versions

Jejak is at an early stage. Security fixes land on the latest release and on `main`.

| Version | Supported |
| --- | --- |
| 0.0.1 (latest release) | Yes |
| Older versions | No |

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub's Private Vulnerability Reporting (PVR):

1. Go to <https://github.com/jejak-dev/jejak>.
2. Open the **Security** tab.
3. Click **Report a vulnerability**.

PVR opens a private thread with the maintainers. Include:

- what the issue is and which part of the code or command triggers it,
- the version (`jejak --version`) and your platform,
- the steps to reproduce, and
- the impact you observed.

If PVR is unavailable to you, open a regular issue that only describes the problem at
a high level, with no exploit details, and ask for a private channel.

### What counts as a vulnerability

In scope:

- reading or writing data outside what the user granted, for example bypassing the
  secret-file blocking rules to read `.env` or `~/.ssh/**`;
- obtaining or exposing API keys, provider credentials, session cookies, or session
  data that belongs to another session;
- bypassing the server's authentication, the `Host`/`Origin` guard, or the
  permission modes and the Bash sandbox;
- remote code execution or command injection against a running Jejak server,
  including through an agent prompt that reaches a shell command;
- forging or tampering with the signed update bundles, or with the data written by
  the app;
- anything that exposes another user's data through the local server.

Out of scope:

- the agent acting exactly as the user configured it (for example running a command
  the user approved in bypass mode);
- findings that require the user to already have full local access to the machine;
- denial of service by exhausting the local machine's resources;
- missing hardening headers on a server that only listens on `127.0.0.1`.

### Threat model in brief

Jejak is a local developer tool. The design assumes:

- **The agent runs shell commands.** The Bash tool, the project command launcher, and
  the PTY terminal can execute commands on your machine. Permission modes per tool,
  a directed sandbox, and a kill switch exist to bound this. Treat any agent run as
  capable of doing what you would allow yourself to do.
- **Provider API keys are secrets.** They can be stored in `~/.jejak/providers.json`
  with file mode `600` (not encrypted at rest) or referenced from an environment
  variable. They must never appear in the repository, in logs, or in the audit log.
- **The server is a loopback service by default.** It binds `127.0.0.1` and checks
  the `Host` and `Origin` headers of API requests against an allowlist
  (`127.0.0.1`, `localhost`, `[::1]`), so a web page in your browser cannot drive it
  from another origin. Binding to a non-loopback host requires a password, unless you
  explicitly pass `--insecure-no-auth`.
- **Local data is trusted but private.** Sessions, audit logs, and memory live under
  `~/.jejak` (override with `JEJAK_HOME`). Anyone with access to your user account
  can read them.
- **Updates are signed.** Update artifacts are signed with a minisign key whose public
  key is pinned in the application, and `latest.json` is fetched from the project's
  GitHub releases.

### Response

There is no guaranteed SLA, but the maintainers aim to:

- acknowledge a report within **7 days**,
- triage and decide within **14 days**, and
- ship a fix and a release note for confirmed issues, and credit the reporter unless
  they ask otherwise.

Unconfirmed or out-of-scope reports may be closed with an explanation. Please give
the maintainers reasonable time before disclosing a confirmed issue publicly.

## Security notes for users

- The desktop app is **not signed** with an OS vendor certificate, so macOS and
  Windows show a warning. That is expected for this stage of the project.
- Do not run Jejak on a machine where other local users can read `~/.jejak`.
- If you bind the server to a non-loopback address, always set a password and prefer
  HTTPS with your own certificate.
