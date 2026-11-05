# Security

## Model

- **No nubes server.** The web app is static files on GitHub Pages; the CLI is
  a single binary. Both talk to `api.github.com` only.
- **Your token, your scope.** Use a fine-grained token limited to one
  repository with *Contents: Read and write*. It can read and write that
  repository's contents and nothing else.
- **Plain folders are not encrypted.** Keep the repository private: anyone
  with access to it, and GitHub itself, can read the files.
- **Encrypted folders** (`nubes init owner/repo --encrypt`, or "Encrypt the
  files end to end" in the web app) store each file's content encrypted with
  [age](https://age-encryption.org) (X25519, ChaCha20-Poly1305). GitHub then
  sees the file names, sizes, dates and commit messages, not the contents. The
  folder's key is in the repository, encrypted with your passphrase (scrypt):
  the passphrase's strength is the folder's. Nobody can reset it.
- Encryption protects the contents, not the folder's shape: someone who can
  write to the repository cannot read the files, but can delete them, or swap
  which encrypted file a name points to (`.nubes/manifest.json` is not
  signed). The history keeps every earlier version. A replaced `key.age` is
  not used by devices that already keep the key, and a new device would
  refuse it ("wrong passphrase").
- A device keeps the folder's key, not the passphrase: the CLI in the macOS
  Keychain or a 0600 file, the web app like its token. Anyone with access to
  that device's storage can read the folder: `nubes lock` (CLI) or "Forget
  the key here" (web) removes it, and signing out of the web app does too.

## Web app

- Strict Content Security Policy injected at build time: scripts from the
  page's origin only (plus WebAssembly), `connect-src` limited to
  `api.github.com`, no inline script or style, Trusted Types required.
- No third-party script, font, analytics or CDN.
- The token is in `localStorage` only if you choose "stay signed in",
  otherwise in `sessionStorage`. Signing out removes it. Anyone with access to
  your browser profile can read it: revoke it on GitHub if a device is lost.
- The page refuses to run inside a frame.
- Offline copies stay in the browser's storage for this site: the last
  listing and files added offline in IndexedDB, the files of folders marked
  "Keep offline" in Cache Storage (decrypted, for an encrypted folder).
  Signing out erases the listing and the offline files; files added offline
  and not sent yet stay until they are.

## CLI

- The token comes from `NUBES_TOKEN`, the macOS Keychain (written through
  `security -i` on stdin, never on a command line), a 0600 file on Linux, or
  `gh auth token`.
- Paths from the remote tree are validated before anything is written, and
  every downloaded or uploaded blob is checked against its git id.

## Reporting

Open a private security advisory on https://github.com/maxgfr/nubes/security/advisories.
