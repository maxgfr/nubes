/**
 * Browser-side hardening that a static host cannot do with headers.
 *
 *  - Trusted Types: the CSP requires them for every script URL (workers,
 *    service worker). The only policy allows same-origin .js files.
 *  - Frame busting: `frame-ancestors` is ignored in a <meta> CSP, so refuse to
 *    run inside a frame (clickjacking).
 */

interface TrustedTypePolicyLike {
  createScriptURL(url: string): unknown;
}

interface TrustedTypesLike {
  createPolicy(
    name: string,
    rules: { createScriptURL(url: string): string },
  ): TrustedTypePolicyLike;
}

let policy: TrustedTypePolicyLike | null | undefined;

/** Same-origin JavaScript only; anything else throws. */
export function checkScriptUrl(url: string, base: string): string {
  const u = new URL(url, base);
  const origin = new URL(base).origin;
  if (u.origin !== origin || !u.pathname.endsWith(".js") || u.search || u.hash) {
    throw new TypeError(`blocked script URL: ${url}`);
  }
  return u.href;
}

export function trustedScriptUrl(url: string): unknown {
  const base = globalThis.location?.href ?? "http://localhost/";
  const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (!tt) return checkScriptUrl(url, base);
  if (policy === undefined) {
    policy = tt.createPolicy("nubes", {
      createScriptURL: (u) => checkScriptUrl(u, globalThis.location.href),
    });
  }
  return policy ? policy.createScriptURL(url) : checkScriptUrl(url, base);
}

/** Returns true (and blanks the page) when loaded inside a frame. */
export function frameBust(): boolean {
  if (typeof window === "undefined" || window.top === window.self) return false;
  document.documentElement.replaceChildren();
  try {
    if (window.top) window.top.location.href = window.location.href;
  } catch {
    // Cross-origin parent: the page stays blank.
  }
  return true;
}
