# nubes repository format (version 3)

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

## Pools (version 3)

A nubes folder can also be spread over several repositories of one account,
named `<name>-1`, `<name>-2`… (a *pool*; `nubes init <name>`, or a name in
the web app). nubes creates them, private, as they fill up. Each member is a
whole repository (no prefix) on its default branch, and says it belongs:

```
<name>-<n>/.nubes/meta.json   { "format": "nubes", "version": 3, "mode": "plain" | "age", "pool": "<name>", "index": n, "maxSize": <bytes>, "createdAt": …, "recipient"?: … }
```

- **Members** are numbered from 1 without gaps. A client knows the members it
  has seen and checks whether `<name>-<n+1>` exists before each sync. A
  repository of that name whose meta.json does not say `"pool": "<name>"`
  (and that is not empty) is refused, never taken over.
- **The folder** is the union of the members' trees (`merge` in
  `crates/core/src/pool.rs`). A path lives in one member, its *owner*. If two
  members hold the same path (two devices added it at the same time), the
  lowest index keeps it: an identical copy elsewhere is deleted, a different
  one is renamed to a conflict copy in its member. The planner then runs on
  the union, as for one repository.
- **Placement** (`place`): a change to an existing path goes to its owner (a
  file never moves between repositories, so no change ever needs a commit in
  two of them). A new path goes to the first member with room that already
  holds the same content (a rename uploads nothing), else to the first member
  with room, else to a new member. A member has room if its size (GitHub's
  `size`, every version counted, updated with a delay) plus what the sync
  already placed in it, plus the file, stays within `maxSize` (5 GiB by
  default, set when the pool is created); an empty member always takes one
  file.
- **Commits**: one per member that changes, members that receive files first
  and those that only lose some last, each fast-forward only. If one of them
  moved meanwhile, the client reads every member again and plans again: what
  was already committed then looks the same on both sides.
- **Encryption**: the whole pool or none of it. The first member's
  `key.age` is copied into every new member (same identity, same
  passphrase), each member has its own `manifest.json`. A device keeps one
  key for the pool.

## Local state (CLI: `<folder>/.nubes/`, web: IndexedDB)

- `config.json`: `{ repo, branch, prefix, device }`, or for a pool
  `{ pool: { owner, name, maxSize }, device }`.
- `state.json`: `{ head, files: { <path>: { sha, size, mtime } } }`, the base
  snapshot of the last sync. `sha` is the git blob id, `mtime` (ns) is set
  only when the local file is known to have that content, and lets the next
  scan skip re-hashing unchanged files. A pool records `heads` (repository →
  commit) instead of `head`, and `members` (`[{ repo, branch }]`).

## Sync

`plan(base, local, remote)` in `crates/core/src/plan.rs`; the cases are
listed in `crates/core/tests/vectors.json`. A sync then:

1. uploads the missing blobs (`POST /git/blobs`, skipped for ids already in the tree);
2. creates one tree on top of the remote tree (`base_tree`, `sha: null` deletes) and one commit;
3. moves the branch without force; if GitHub refuses (someone pushed), it starts over from step 0;
4. writes downloads through a temporary file and a rename, renames conflict copies, deletes;
5. stores the planned next base.

In a pool, steps 1 to 3 run once per member that changes (see Pools), and
a new member is created first if the placement asks for one.

Conflict copies are named `<stem>.conflict-<device>-<YYYYMMDD-HHMM>[-n]<ext>`.
