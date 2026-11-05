/**
 * What the app remembers between visits, in localStorage: the linked
 * repository, and the token only if the user asked to stay signed in on
 * this device (otherwise it lives in sessionStorage and dies with the tab).
 * Everything read back is validated: a corrupted entry is ignored.
 */

export interface Link {
  /** `owner/name`. */
  repo: string;
  branch: string;
  prefix: string;
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
