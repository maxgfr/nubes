# Security

## Model

- **No nubes server.** The web app is static files on GitHub Pages; the CLI is
  a single binary. Both talk to `api.github.com` only.
- **Your token, your scope.** Use a fine-grained token limited to one
  repository with *Contents: Read and write*. It can read and write that
  repository's contents and nothing else.
- **Files are not encrypted** by nubes (version 1). Keep the repository
  private. Anyone with access to the repository, and GitHub itself, can read
  the files. End-to-end encryption is planned as a repository mode.

## Web app

- Strict Content Security Policy injected at build time: scripts from the
  page's origin only (plus WebAssembly), `connect-src` limited to
  `api.github.com`, no inline script or style, Trusted Types required.
- No third-party script, font, analytics or CDN.
- The token is in `localStorage` only if you choose "stay signed in",
  otherwise in `sessionStorage`. Signing out removes it. Anyone with access to
  your browser profile can read it: revoke it on GitHub if a device is lost.
- The page refuses to run inside a frame.

## CLI

- The token comes from `NUBES_TOKEN`, the macOS Keychain (written through
  `security -i` on stdin, never on a command line), a 0600 file on Linux, or
  `gh auth token`.
- Paths from the remote tree are validated before anything is written, and
  every downloaded or uploaded blob is checked against its git id.

## Reporting

Open a private security advisory on https://github.com/maxgfr/nubes/security/advisories.
