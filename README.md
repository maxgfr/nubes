# nubes

[![CI](https://github.com/maxgfr/nubes/actions/workflows/ci.yml/badge.svg)](https://github.com/maxgfr/nubes/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/maxgfr/nubes?filter=cli-v*&label=cli)](https://github.com/maxgfr/nubes/releases)

**Your files in a GitHub repository you own.** Drop them in the browser from any
device, sync a folder from the terminal, get every version back from the
history. There is no nubes server: the web app and the CLI talk to the GitHub
API directly with a fine-grained token you create.

**Web app:** https://maxgfr.github.io/nubes/ · **CLI:** `brew install maxgfr/tap/nubes`

## How it works

- Files are stored **as plain files** in a repository (or a sub-folder of one).
  You can read them on github.com, clone them with git, and the history keeps
  every version.
- Each change is **one commit**: dropping 40 photos makes one commit, not 40.
  A commit only lands if nobody else committed in the meantime; otherwise
  nubes reads the branch again and re-plans. Several devices can work at the
  same time without overwriting each other.
- A file is identified by its **git blob id** (the SHA-1 git computes), so
  nubes compares a local file with the remote copy without downloading it,
  and never uploads the same content twice.
- The sync engine (`crates/core`, in Rust) is **shared**: the CLI runs it
  natively, the web app runs the same code compiled to WebAssembly. Both
  replay the same test vectors (`crates/core/tests/vectors.json`).

### Sync rules

| Situation | What happens |
|---|---|
| Changed on one side | Copied to the other side |
| Deleted on one side, unchanged on the other | Deleted on both |
| Deleted on one side, **edited** on the other | The edit wins |
| Edited on both sides | Both kept: your copy becomes `name.conflict-<device>-<date>.ext` |
| Larger than 100 MB | Skipped (GitHub's limit), and reported |

`.nubesignore` (gitignore syntax) keeps files out. `.nubes/`, `.git/`,
`.DS_Store`, `Thumbs.db` and Office lock files are always ignored.

## Devices

| Device | How |
|---|---|
| **iPad, iPhone, Android, any browser** | Open the web app. Upload files or whole folders (button, or drag from the Files app), preview, download a folder as a zip, restore old versions. What other devices push shows up within 30 s, or as soon as you come back to the tab. Install it to the home screen as an app. |
| **Mac, Linux** | The CLI: `nubes sync` on demand, `nubes watch` to keep a folder in sync. |
| **Chrome, Edge (desktop)** | The web app can also keep a local folder in two-way sync while the tab is open ("Sync a folder of this computer"), with the same engine as the CLI. |

Safari (iPadOS, macOS) does not let a web page keep write access to a folder,
so the browser cannot mirror a folder of the Files app by itself. Because the
repository is ordinary git, a git client for iPad (Working Copy, for
instance) can clone it into Files when you need that.

## Setup

1. Create a **private** repository, e.g. [`nubes-files`](https://github.com/new?name=nubes-files&visibility=private).
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new?name=nubes&contents=write)
   with access to **only that repository** and **Contents: Read and write**.
3. Paste it in the web app, or run `nubes login`.

The token is kept in your browser (local storage if you choose "stay signed
in", the tab's session storage otherwise) and is only ever sent to
`api.github.com`; the page's Content Security Policy forbids any other
destination. The CLI keeps it in the macOS Keychain, or in
`~/.config/nubes/credentials` (mode 0600) on Linux. `NUBES_TOKEN` and
`gh auth token` work too.

## CLI

```sh
brew install maxgfr/tap/nubes

nubes login                      # paste the token (checked with GitHub, then stored)
cd ~/Documents/cloud
nubes init you/nubes-files       # or you/repo:sub/folder, --branch name, --device name
nubes status                     # what a sync would do
nubes sync                       # two-way, one commit
nubes watch                      # sync every 30 s while running (--interval 10)
```

| Command | |
|---|---|
| `nubes push` / `nubes pull` | One direction only (`pull` never loses an unpushed edit: it keeps a conflict copy) |
| `nubes ls [folder]` | List the files in the repository |
| `nubes log [path]` | Commits that changed a path |
| `nubes restore <path> --at <commit>` | Write an older version into the folder (then `nubes sync`) |
| `nubes whoami` | Account and token source in use |
| `nubes skill` | Print the agent skill |

The folder's state lives in `.nubes/` (config and the last synced snapshot).
Without `state.json` the next sync sees both sides as new: identical files
match, differing ones become conflict copies, nothing is deleted.

## Agent skill

```sh
npx skills add maxgfr/nubes
```

Teaches coding agents to use the `nubes` CLI ([`skills/nubes/SKILL.md`](skills/nubes/SKILL.md)).

## Limits

- 100 MB per file (GitHub's limit for blobs; Git LFS is not reachable from a
  browser). GitHub recommends keeping a repository under a few GB.
- About 5,000 API requests an hour per token. Syncing an unchanged folder
  costs one request; a change costs about three plus one per new file.
- Empty folders do not exist in git: a folder appears once it has a file.

## Development

```sh
bun install
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.128
bun run engine      # Rust → WebAssembly (src/engine/pkg)
bun run dev         # http://localhost:5173/?nosw
bun run test        # unit tests, engine vectors, CLI against a fake GitHub
cargo test --workspace
bun run test:e2e    # Playwright: Chromium, iPad (Chromium and WebKit)
```

The tests never touch GitHub: `test/fake-github.ts` is an in-memory GitHub
(real blob ids, fast-forward-only refs, GitHub's quirks) that serves the unit
tests, the Playwright tests and the CLI integration tests.

See [FORMAT.md](FORMAT.md) for the repository format and [SECURITY.md](SECURITY.md)
for the threat model.

## License

MIT
