/** Sign in with a fine-grained token, then pick the repository to use. */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { RepoInfo } from "../github/client";
import { normalizePrefix } from "../github/repo";
import { chooseRepo, describeError, session, signIn, signOut } from "../state";
import { NEW_REPO_URL, TOKEN_URL, TOKENS_URL } from "../store/settings";
import { IconCloud } from "./icons";

export function SignIn() {
  const token = useSignal("");
  const remember = useSignal(true);
  const error = useSignal<string | null>(null);
  const pending = useSignal(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!token.value.trim()) return;
    pending.value = true;
    error.value = null;
    try {
      await signIn(token.value, remember.value);
    } catch (err) {
      error.value = describeError(err);
    } finally {
      pending.value = false;
    }
  };
  return (
    <main class="onboarding">
      <div class="brand-hero">
        <IconCloud size={40} />
        <h1>nubes</h1>
      </div>
      <p class="lede">
        Your files in a GitHub repository you own. Drop them here from any device, sync a folder
        from the terminal, and every version stays in the history. No server in between: this page
        talks to GitHub directly.
      </p>
      <ol class="steps">
        <li>
          <a href={NEW_REPO_URL} target="_blank" rel="noopener noreferrer">
            Create a private repository
          </a>{" "}
          (or use an existing one).
        </li>
        <li>
          <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
            Create a fine-grained token
          </a>{" "}
          with access to <b>only that repository</b> and the permission{" "}
          <b>Contents: Read and write</b>.
        </li>
        <li>Paste it here.</li>
      </ol>
      <form class="card form" onSubmit={submit}>
        <label for="token">GitHub token</label>
        <input
          id="token"
          type="password"
          autocomplete="off"
          spellcheck={false}
          placeholder="github_pat_…"
          value={token.value}
          onInput={(e) => {
            token.value = e.currentTarget.value;
          }}
        />
        <label class="check">
          <input
            type="checkbox"
            checked={remember.value}
            onChange={(e) => {
              remember.value = e.currentTarget.checked;
            }}
          />
          Stay signed in on this device
        </label>
        {error.value && (
          <p class="error" role="alert">
            {error.value}
          </p>
        )}
        <button class="btn primary" type="submit" disabled={pending.value || !token.value.trim()}>
          {pending.value ? "Checking…" : "Continue"}
        </button>
        <p class="fine">The token stays in this browser and is only ever sent to api.github.com.</p>
      </form>
    </main>
  );
}

export function PickRepo() {
  const repos = useSignal<RepoInfo[] | null>(null);
  const manual = useSignal("");
  const prefix = useSignal("");
  const query = useSignal("");
  const error = useSignal<string | null>(null);
  const pending = useSignal(false);
  const s = session.value;

  useEffect(() => {
    if (!s) return;
    s.gh
      .repos()
      .then((r) => {
        repos.value = r.filter((x) => x.canPush);
      })
      .catch((err) => {
        error.value = describeError(err);
        repos.value = [];
      });
  }, [s]);

  const pick = async (full: string) => {
    if (!s) return;
    pending.value = true;
    error.value = null;
    try {
      const info = await s.gh.repo(full.trim());
      if (!info.canPush) throw new Error(`The token cannot write to ${info.fullName}.`);
      await chooseRepo({
        repo: info.fullName,
        branch: info.defaultBranch,
        prefix: normalizePrefix(prefix.value),
      });
    } catch (err) {
      error.value = describeError(err);
    } finally {
      pending.value = false;
    }
  };

  const shown = filterRepos(repos.value ?? [], query.value);

  return (
    <main class="onboarding">
      <div class="brand-hero">
        <IconCloud size={40} />
        <h1>Choose a repository</h1>
      </div>
      <p class="lede">
        Signed in as <b>{s?.login}</b>. Pick the repository that will hold your files. A private one
        is best.
      </p>
      <div class="card">
        {repos.value === null ? (
          <p class="muted">Loading repositories…</p>
        ) : repos.value.length === 0 ? (
          <p class="muted">
            No repository visible to this token. Check that it has access to at least one
            repository, or type its name below.
          </p>
        ) : (
          <form
            class="repo-search"
            onSubmit={(e) => {
              e.preventDefault();
              const only = shown.length === 1 ? shown[0] : undefined;
              if (only) void pick(only.fullName);
            }}
          >
            <label class="visually-hidden" for="repo-search">
              Search repositories
            </label>
            <input
              id="repo-search"
              type="search"
              placeholder={`Search ${repos.value.length} repositories`}
              value={query.value}
              spellcheck={false}
              autocapitalize="off"
              autocomplete="off"
              onInput={(e) => {
                query.value = e.currentTarget.value;
              }}
            />
            {shown.length === 0 && (
              <p class="muted small">No repository matches “{query.value.trim()}”.</p>
            )}
          </form>
        )}
        {shown.length > 0 && (
          <ul class="repo-list">
            {shown.map((r) => (
              <li key={r.fullName}>
                <button
                  type="button"
                  class="repo-item"
                  disabled={pending.value}
                  onClick={() => pick(r.fullName)}
                >
                  <span>{r.fullName}</span>
                  <span class={`tag${r.private ? "" : " tag-warn"}`}>
                    {r.private ? "private" : "public"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          class="form inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.value.trim()) void pick(manual.value);
          }}
        >
          <label for="repo">Or type owner/name</label>
          <div class="row">
            <input
              id="repo"
              placeholder="you/nubes-files"
              value={manual.value}
              spellcheck={false}
              autocapitalize="off"
              onInput={(e) => {
                manual.value = e.currentTarget.value;
              }}
            />
            <button class="btn" type="submit" disabled={pending.value || !manual.value.trim()}>
              Use
            </button>
          </div>
          <label for="prefix">Folder inside the repository (optional)</label>
          <input
            id="prefix"
            placeholder="leave empty to use the whole repository"
            value={prefix.value}
            spellcheck={false}
            autocapitalize="off"
            onInput={(e) => {
              prefix.value = e.currentTarget.value;
            }}
          />
        </form>
        {error.value && (
          <p class="error" role="alert">
            {error.value}
          </p>
        )}
      </div>
      <div class="card token-help">
        <p>
          <b>Your private repository is missing?</b> The token only sees the repositories it was
          given. Change its “Repository access” on GitHub (
          <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
            your fine-grained tokens
          </a>
          ), then reload this page, or sign in with another token.
        </p>
        <button type="button" class="btn" onClick={() => void signOut()}>
          Use another token
        </button>
      </div>
    </main>
  );
}

/** Repositories whose name contains every word of the query (case-insensitive). */
export function filterRepos<T extends { fullName: string }>(repos: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return repos;
  return repos.filter((r) => {
    const name = r.fullName.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}
