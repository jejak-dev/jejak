# Installing Jejak

Jejak ships as a desktop app for macOS and Windows. This page covers the
install, the honest warnings you will hit, where your data lives, and how to
remove the app again.

- [Requirements](#requirements)
- [Install on macOS](#install-on-macos)
- [Gatekeeper warning on macOS](#gatekeeper-warning-on-macos)
- [Install on Windows (beta)](#install-on-windows-beta)
- [Windows (beta): limitations](#windows-beta-limitations)
- [Automatic updates](#automatic-updates)
- [Where your data lives](#where-your-data-lives)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Requirements

- **macOS 12 (Monterey) or newer.** Both Apple silicon and Intel are published.
- **Windows x64.** Windows builds are marked **beta**; they are not signed with
  a vendor certificate, so SmartScreen will warn you.
- To run Jejak from source instead of as an app: **Bun 1.4 or newer**.

## Install on macOS

### Option A: the one-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh
```

This downloads the signed release manifest (`latest.json`), fetches the app
bundle that matches your CPU, and installs `Jejak.app` into `~/Applications`.
It never needs `sudo`, and it never touches your data in `~/.jejak`.

Useful knobs:

| Variable | Meaning | Default |
| --- | --- | --- |
| `JEJAK_INSTALL_DIR` | Where `Jejak.app` is placed | `~/Applications` |
| `JEJAK_CHANNEL` | `stable` or `beta` | `stable` |
| `JEJAK_LATEST_JSON_URL` | Release manifest URL | per channel |

```bash
# Install the beta channel
curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | JEJAK_CHANNEL=beta sh
```

Environment variables go on the `sh` side of the pipe, so they reach the
installer and not just `curl`.

The installer can also be run from a local copy, which is handy if you want to
read it first:

```bash
curl -fsSLO https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh
less install.sh
sh install.sh
```

### Option B: the disk image

1. Download the `.dmg` for your CPU from
   [GitHub Releases](https://github.com/jejak-dev/jejak/releases) — one build
   for Apple silicon (`aarch64`) and one for Intel (`x86_64`).
2. Open the `.dmg` and drag `Jejak.app` into your **Applications** folder.
3. Eject the disk image and launch Jejak from Applications.

If you prefer to skip the download page, the
[download page](https://jejak-dev.github.io/jejak/) lists the same files.

## Gatekeeper warning on macOS

Jejak is **not signed with an Apple Developer ID certificate and is not
notarized**. macOS therefore shows a warning the first time you open it. This
is expected, not a broken download, and the app does not need a network
connection to run.

To open it:

1. Right-click (or Control-click) `Jejak.app` in Applications and choose
   **Open**.
2. In the dialog, choose **Open** again to confirm.

If the dialog has already been dismissed, open
**System Settings → Privacy & Security** and press **Open Anyway** next to the
message about Jejak. The warning shows up on the first launch for each user
account; once you have approved it, macOS normally stops asking.

If macOS reports the app as "damaged" instead of "unidentified developer", the
quarantine attribute is likely still set. The one-line installer clears that
attribute for you; if you installed by hand, run:

```bash
xattr -dr com.apple.quarantine /Applications/Jejak.app
```

## Install on Windows (beta)

Windows builds are published as an NSIS installer (`.exe`) for x64. The
installer installs **for the current user only**, so it does not need
administrator rights.

1. Download the `.exe` from
   [GitHub Releases](https://github.com/jejak-dev/jejak/releases).
2. Run it and follow the prompts.
3. Windows SmartScreen shows "Windows protected your PC" because the binary is
   unsigned. Choose **More info → Run anyway**. Only do this for a build you
   downloaded from the official releases page.

Data is stored in `%USERPROFILE%\.jejak`.

## Automatic updates

Jejak updates itself. The app checks for a new release about every six hours,
and you can also check on demand.

- Open the app and go to the settings page (**Set up provider** in the
  sidebar). At the bottom of that page is the **Pembaruan aplikasi** (app
  update) card.
- **Periksa sekarang** checks immediately. When an update is found, press
  **Perbarui**, then **Mulai ulang sekarang** to finish.
- **Periksa otomatis** turns the periodic check on or off. It is on by default.
- **Kanal pembaruan** selects `Stabil` or `Beta`. The beta channel contains
  pre-release builds that may not be stable; the stable channel only carries
  full releases.
- The app never installs or restarts an update on its own — you always click.

These settings are stored in the file `desktop.json` inside the app's config
folder:

- macOS: `~/Library/Application Support/io.github.jejak-dev.jejak/desktop.json`
- Windows: `%APPDATA%\io.github.jejak-dev.jejak\desktop.json`

Every release is signed with a minisign key whose public key is pinned inside
the application, so a tampered bundle will not install. Updates are fetched over
HTTPS from `github.com/jejak-dev/jejak` only.

## Where your data lives

Jejak is local-first. Sessions, memory files, provider settings and API keys
live in one folder:

- macOS and Linux: `~/.jejak`
- Windows: `%USERPROFILE%\.jejak`

Set `JEJAK_HOME` to move that folder somewhere else.

```
~/.jejak/
  providers.json     provider profiles and API keys (file mode 600)
  memory/            memory files, the source of truth
  sessions/          session and event storage
  backup/<version>/  automatic backup taken before a data version upgrade
```

Before Jejak upgrades the on-disk data format it writes a copy to
`~/.jejak/backup/<version>/`. Older backups are pruned, so keep your own copy
if a folder matters to you.

API keys are stored unencrypted on your own machine. Anyone who can read your
home directory can read them.

## Troubleshooting

**Check the environment first.** The `doctor` command reports the runtime, git,
provider registry, session storage, data version, memory, workspaces,
checkpoints, MCP servers, the sandbox and the Claude Agent SDK:

```bash
jejak doctor
```

From an installed app bundle on macOS, use the bundled CLI directly:

```bash
/Applications/Jejak.app/Contents/MacOS/jejak doctor
```

**The app will not open on macOS.** See
[Gatekeeper warning on macOS](#gatekeeper-warning-on-macos) above.

**The server does not start.** Jejak listens on `127.0.0.1:3000` by default.
If another program already uses that port, pick another one:

```bash
jejak serve --port 3001
```

**A provider reports a missing key.** Add the API key in the settings page, or
point the provider at an environment variable instead of storing it on disk.

**An update never arrives.** Check the channel in the update card, then press
**Periksa sekarang**. If the machine is offline, the check simply fails and
retries later.

**Sessions or memory look empty after moving machines.** Copy the whole
`~/.jejak` folder to the new machine. Do not copy only `memory/`, because
session state and provider settings live next to it.

## Windows (beta): limitations

The Windows build is beta. Jejak starts and works, but these parts are
missing or limited on Windows:

- **The Terminal panel and the command launcher (Commands) need an opt-in.**
  Start Jejak with `JEJAK_TERMINAL=1` to enable them; on Windows the terminal
  runs **Command Prompt** (`cmd.exe`, the path in `COMSPEC`). There is no busy
  indicator while a command runs, and this has not been verified on real
  Windows hardware yet.
- **There is no sandbox for the Bash tool.** Windows has neither
  `sandbox-exec` (macOS) nor `bwrap` (Linux), so the sandbox reports itself
  as unavailable. While the sandbox mode is not **Mati** (off), new sessions
  fail; set the sandbox mode to **Mati** in the sandbox settings first.
- **There is no native folder picker.** The macOS Finder dialog has no
  Windows counterpart, so type or paste the folder path instead.
- **Dictation is not available.** It relies on the browser's Web Speech API,
  which the Windows WebView2 runtime does not provide, so the dictation
  button never appears.
- **Git for Windows is required.** `jejak doctor` checks that `git` is on
  `PATH`; the Bash tool of the Agent SDK also needs Git Bash
  (`C:\Program Files\Git\bin\bash.exe`), or set `CLAUDE_CODE_GIT_BASH_PATH`.
- **`chmod` means nothing here.** Provider keys live in
  `%USERPROFILE%\.jejak`; on Windows the file mode carries no meaning, so
  their protection depends on the permissions of your Windows account.
- **Not verified on real Windows hardware yet.** The Windows build is
  released as a beta and has not been tested on an actual Windows machine.

## Uninstall

### macOS

- Drag `Jejak.app` from Applications to the Trash, or run the installer with
  `--uninstall`:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh | sh -s -- --uninstall
  ```

  The uninstaller removes `Jejak.app` only. Your data in `~/.jejak` stays
  behind.

- To remove the data as well, add `--purge-data`. It asks for a `y` on the
  terminal first, so run it from a terminal instead of a pipe:

  ```bash
  curl -fsSLO https://raw.githubusercontent.com/jejak-dev/jejak/main/install.sh
  sh install.sh --uninstall --purge-data
  ```

### Windows

- Open **Settings → Apps → Installed apps** (on Windows 10: **Settings → Apps
  → Apps & features**), pick **Jejak**, and choose **Uninstall**. An uninstaller
  is also added to the Start menu.
- Remove the data manually by deleting `%USERPROFILE%\.jejak`.

### Removing the data by hand

The data folder can be deleted at any time:

- macOS and Linux: `rm -rf ~/.jejak`
- Windows: delete the `%USERPROFILE%\.jejak` folder

> **Warning:** deleting `~/.jejak` deletes your sessions, memory files, and
> stored provider API keys. There is no undo. If you only want to reinstall the
> app, leave the folder alone and reinstall over it.

---

See also [README.md](README.md), [README.id.md](README.id.md), and
[SECURITY.md](SECURITY.md).
