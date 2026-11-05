# nubes repository format (version 1)

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
under `.nubes/` are nubes' own and are never synced.

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
