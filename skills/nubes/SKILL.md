---
name: nubes
description: Sync a local folder with GitHub repositories using the nubes CLI (files stored as plain files in private repos the user owns, with full history; nubes creates more repos as they fill up). Use when the user wants to back up, sync, restore or list files kept in their nubes repository, see what changed, or recover an older version of a file.
---

# nubes

`nubes` keeps a folder in sync with GitHub. Given a name (`nubes init
photos`), it stores the files in private repositories `photos-1`,
`photos-2`… of the user's account, creating the next one when a repository
reaches 5 GB (`--max-size`), and shows them as one folder. It can also use
one existing repository (or a sub-folder of one). Files are stored as
ordinary files in git, so every version stays in the history. The web app at
https://maxgfr.github.io/nubes/ reads the same repositories.

## Setup (once per folder)

```sh
brew install maxgfr/tap/nubes
nubes login                    # paste a fine-grained token (see below)
cd ~/Documents/cloud
nubes init photos              # repositories photos-1, photos-2… (created as needed)
nubes init owner/repo          # or one existing repository: owner/repo:sub/folder, --branch name
```

With a name, the token needs "All repositories" with Contents and
Administration set to "Read and write" (to create the repositories); for one
existing repository, Contents read/write on it is enough. The token can also
come from `NUBES_TOKEN` or from `gh auth token`. Every device runs `nubes
init` with the same name to see the same files.

`nubes init photos --encrypt` (or `owner/repo --encrypt`) creates a folder encrypted end to end (new,
empty folders only). It asks for a passphrase. In an encrypted folder, run
`nubes unlock` once per device (or set `NUBES_PASSPHRASE`); never print or
store the passphrase yourself.

## Everyday commands

| Command | What it does |
|---|---|
| `nubes status` | Shows what a sync would do, changes nothing |
| `nubes sync` | Two-way sync: one commit per repository that changes, then downloads |
| `nubes push` / `nubes pull` | One direction only |
| `nubes watch` | Keeps syncing: 2 s after a local change, and when the repository changes (`--interval 15`) |
| `nubes service install` | Runs `nubes watch` for the folder in the background from every login (`status`, `uninstall`) |
| `nubes ls [folder]` | Lists the remote files (every repository of the folder) |
| `nubes log [path]` | Commits that changed a path |
| `nubes restore <path> --at <commit>` | Puts an older version back in the folder (then `nubes sync`) |

## Rules worth knowing

- Edited on both sides: the local copy is kept as
  `name.conflict-<device>-<date>.ext`, nothing is lost.
- Deleted on one side but edited on the other: the edit wins.
- `.nubesignore` (gitignore syntax) excludes files; `.nubes/`, `.git/` and
  `.DS_Store` are always excluded.
- GitHub refuses files over 100 MB (32 KB less in an encrypted folder);
  nubes skips them and says so, it never splits them. `nubes status` also
  shows each repository's size (or warns when a single repository passes
  1 GB: GitHub recommends under 5 GB).
- With a name, a file stays in the repository that holds it (edits included);
  new files go to the first repository with room.
- Always run `nubes status` first when unsure, and never delete
  `.nubes/state.json` (it is the memory of the last sync; without it the
  next sync treats both sides as new and keeps conflict copies).
