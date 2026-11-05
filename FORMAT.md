# nubes repository format (version 2)

A nubes folder is a branch of a GitHub repository, optionally restricted to a
sub-folder (the *prefix*). Nothing in it is specific to nubes except one file:

```
.nubes/meta.json        at the repository root
{ "format": "nubes", "version": 1, "mode": "plain", "createdAt": "<RFC 3339>" }
```

It is written by the first client that uses the repository (through the
contents API, which also works on an empty repository). The rest of the tree
is the user's files, stored as regular blobs (`100644`, or `100755` for
executables). Symlinks and submodules are ignored by nubes.

## Paths

Relative, `/`-separated, no empty, `.` or `..` component, no backslash or NUL.
Anything else in a tree is never written to disk (`unsafePath` skip). Paths
under `.nubes/` at the top of the nubes folder (the prefix, or the
repository root) are nubes' own and are never synced.

## Encrypted folders (version 2, `"mode": "age"`)

A nubes folder can be encrypted end to end with [age](https://age-encryption.org).
It is chosen when the folder is created, and only for an empty folder; a
plain folder is never converted (create a new repository, or a new folder
`owner/repo:folder`, and copy the files there). A folder is encrypted when
it holds `.nubes/key.age`:

```
<folder>/.nubes/meta.json      { "format": "nubes", "version": 2, "mode": "age", "recipient": "age1…", "createdAt": … }
<folder>/.nubes/key.age        the folder's X25519 identity (AGE-SECRET-KEY-1…), encrypted with the passphrase (scrypt, work factor 18)
<folder>/.nubes/manifest.json  { "version": 1, "files": { "<path>": { "plainSha", "size", "blobSha" } } }
<folder>/<path>.age            each file, encrypted to the identity's recipient
```

- Only the contents are encrypted: paths, sizes and dates stay visible.
- `plainSha` is the git blob id of the plain content. The engine compares
  these ids, as in a plain folder; the planner does not change.
- Encryption is not deterministic, so the same content stored again gets a
  new `blobSha`. The manifest records it so that unchanged content is never
  encrypted or uploaded again (a move reuses the blob).
- The manifest is written in the same commit as the files. A `<path>.age`
  whose blob is not the manifest's (written by something else than nubes),
  and any other file, are left alone.
- Each device asks the passphrase once and keeps the identity: the CLI in the
  macOS Keychain or a 0600 file next to its credentials, the web app like its
  token (localStorage when signed in to stay, else the tab's session).

## Local state (CLI: `<folder>/.nubes/`, web: IndexedDB)

- `config.json`: `{ repo, branch, prefix, device }`.
- `state.json`: `{ head, files: { <path>: { sha, size, mtime } } }`, the base
  snapshot of the last sync. `sha` is the git blob id, `mtime` (ns) is set
  only when the local file is known to have that content, and lets the next
  scan skip re-hashing unchanged files.

## Sync

`plan(base, local, remote)` in `crates/core/src/plan.rs`; the cases are
listed in `crates/core/tests/vectors.json`. A sync then:

1. uploads the missing blobs (`POST /git/blobs`, skipped for ids already in the tree);
2. creates one tree on top of the remote tree (`base_tree`, `sha: null` deletes) and one commit;
3. moves the branch without force; if GitHub refuses (someone pushed), it starts over from step 0;
4. writes downloads through a temporary file and a rename, renames conflict copies, deletes;
5. stores the planned next base.

Conflict copies are named `<stem>.conflict-<device>-<YYYYMMDD-HHMM>[-n]<ext>`.
