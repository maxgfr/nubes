/**
 * What the app remembers between visits, in localStorage: the linked
 * repository, and the token only if the user asked to stay signed in on
 * this device (otherwise it lives in sessionStorage and dies with the tab).
 * Everything read back is validated: a corrupted entry is ignored.
 */

export interface Link {
  /** `owner/name`; for a pool, `owner/<pool name>` (its repositories are `<name>-1`, `<name>-2`…). */
  repo: string;
  /** "" for a pool (each repository uses its default branch). */
  branch: string;
  prefix: string;
  /** A folder spread over repositories nubes creates as they fill up. */
  pool?: { owner: string; name: string; maxSize: number };
}

/** The link of the pool `name` of `owner`. */
export function poolLink(owner: string, name: string, maxSize: number): Link {
  return { repo: `${owner}/${name}`, branch: "", prefix: "", pool: { owner, name, maxSize } };
}

/** A pool name: becomes `<name>-1`… on GitHub. */
export function isPoolName(name: string): boolean {
  return /^[\w.-]{1,90}$/.test(name) && !name.startsWith(".");
}

/** How a link is shown: `owner/repo`, `owner/repo:folder` or the pool's name. */
export function linkLabel(l: Link): string {
  if (l.pool) return l.pool.name;
  return l.prefix ? `${l.repo}:${l.prefix}` : l.repo;
}

const LINK_KEY = "nubes.link.v1";
const TOKEN_KEY = "nubes.token.v1";
const DEVICE_KEY = "nubes.device.v1";

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function isLink(v: unknown): v is Link {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.pool !== undefined) {
    const p = o.pool as Record<string, unknown> | null;
    return (
      !!p &&
      typeof p.owner === "string" &&
      /^[\w.-]+$/.test(p.owner) &&
      typeof p.name === "string" &&
      isPoolName(p.name) &&
      typeof p.maxSize === "number" &&
      p.maxSize > 0 &&
      o.repo === `${p.owner}/${p.name}` &&
      o.branch === "" &&
      o.prefix === ""
    );
  }
  return (
    typeof o.repo === "string" &&
    /^[\w.-]+\/[\w.-]+$/.test(o.repo) &&
    typeof o.branch === "string" &&
    o.branch.length > 0 &&
    typeof o.prefix === "string"
  );
}

export function loadLink(): Link | null {
  try {
    const v: unknown = JSON.parse(storage("local")?.getItem(LINK_KEY) ?? "null");
    return isLink(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveLink(link: Link | null): void {
  const s = storage("local");
  if (!s) return;
  if (link) s.setItem(LINK_KEY, JSON.stringify(link));
  else s.removeItem(LINK_KEY);
}

export function loadToken(): { token: string; remember: boolean } | null {
  const local = storage("local")?.getItem(TOKEN_KEY);
  if (local) return { token: local, remember: true };
  const session = storage("session")?.getItem(TOKEN_KEY);
  if (session) return { token: session, remember: false };
  return null;
}

export function saveToken(token: string | null, remember = false): void {
  storage("local")?.removeItem(TOKEN_KEY);
  storage("session")?.removeItem(TOKEN_KEY);
  if (token) storage(remember ? "local" : "session")?.setItem(TOKEN_KEY, token);
}

const KEY_PREFIX = "nubes.key.v1:";
const keyName = (l: Link) => `${KEY_PREFIX}${l.repo}#${l.branch}#${l.prefix}`;

/**
 * The key of an encrypted folder, kept like the token: in localStorage when
 * the user stays signed in, else for this tab only. (The key, not the
 * passphrase: the passphrase may be used elsewhere, and scrypt runs once.)
 */
export function loadKey(l: Link): string | null {
  return storage("local")?.getItem(keyName(l)) ?? storage("session")?.getItem(keyName(l)) ?? null;
}

export function saveKey(l: Link, secret: string, remember: boolean): void {
  storage("local")?.removeItem(keyName(l));
  storage("session")?.removeItem(keyName(l));
  storage(remember ? "local" : "session")?.setItem(keyName(l), secret);
}

export function forgetKey(l: Link): void {
  storage("local")?.removeItem(keyName(l));
  storage("session")?.removeItem(keyName(l));
}

/** On sign-out: every key goes with the token. */
export function forgetKeys(): void {
  for (const kind of ["local", "session"] as const) {
    const s = storage(kind);
    if (!s) continue;
    for (const k of Object.keys(s)) if (k.startsWith(KEY_PREFIX)) s.removeItem(k);
  }
}

/** A name for this browser, used in commit messages and conflict copies. */
export function deviceName(): string {
  const s = storage("local");
  const saved = s?.getItem(DEVICE_KEY);
  if (saved) return saved;
  const ua = globalThis.navigator?.userAgent ?? "";
  const touch = (globalThis.navigator?.maxTouchPoints ?? 0) > 1;
  const name =
    /iPad/.test(ua) || (/Macintosh/.test(ua) && touch)
      ? "ipad"
      : /iPhone/.test(ua)
        ? "iphone"
        : /Android/.test(ua)
          ? "android"
          : "web";
  s?.setItem(DEVICE_KEY, name);
  return name;
}

export function setDeviceName(name: string): void {
  storage("local")?.setItem(DEVICE_KEY, name.trim() || "web");
}

/**
 * “New fine-grained token” page. GitHub ignores pre-filling parameters on
 * this page, so the onboarding spells out the steps instead.
 */
export const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** The user's fine-grained tokens (to change a token's repository access). */
export const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

/** Pre-filled “new private repository” page. */
export const NEW_REPO_URL = "https://github.com/new?name=nubes-files&visibility=private";
