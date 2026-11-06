/** After sign-in: name the folder (nubes creates its repositories), or pick one repository. Loaded on demand. */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { RepoInfo } from "../github/client";
import { normalizePrefix } from "../github/repo";
import { chooseRepo, createEncrypted, describeError, openPool, session, signOut } from "../state";
import { isPoolName, TOKENS_URL } from "../store/settings";
import { IconCloud } from "./icons";
import { filterRepos, isPublicOnly, TokenSteps } from "./Onboarding";

export function PickRepo() {
  const name = useSignal("nubes");
  const existing = useSignal(false);
  const repos = useSignal<RepoInfo[] | null>(null);
  const manual = useSignal("");
  const prefix = useSignal("");
  const query = useSignal("");
  const encrypt = useSignal(false);
  const pass = useSignal("");
  const pass2 = useSignal("");
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

  /** The passphrase to encrypt with, or null; throws if the two differ. */
  const passphrase = (): string | null => {
    if (!encrypt.value) return null;
    if (pass.value.length < 10)
      throw new Error(
        "Choose a passphrase of at least 10 characters (several random words are best).",
      );
    if (pass.value !== pass2.value) throw new Error("The two passphrases differ.");
    return pass.value;
  };

  const create = async () => {
    const n = name.value.trim();
    pending.value = true;
    error.value = null;
    try {
      if (!isPoolName(n))
        throw new Error("A name of letters, digits, “-”, “_” or “.”, such as “nubes” or “photos”.");
      await openPool(n, passphrase());
    } catch (err) {
      error.value = describeError(err);
    } finally {
      pending.value = false;
    }
  };

  const pick = async (full: string) => {
    if (!s) return;
    pending.value = true;
    error.value = null;
    try {
      const info = await s.gh.repo(full.trim());
      if (!info.canPush || !(await s.gh.canWrite(info.fullName))) {
        throw new Error(
          `The token can read ${info.fullName} but not write to it. On GitHub, edit the token: under Permissions, set Contents to “Read and write”.`,
        );
      }
      const next = {
        repo: info.fullName,
        branch: info.defaultBranch,
        prefix: normalizePrefix(prefix.value),
      };
      const secret = passphrase();
      if (secret === null) await chooseRepo(next);
      else await createEncrypted(next, secret);
    } catch (err) {
      error.value = describeError(err);
    } finally {
      pending.value = false;
    }
  };

  const shown = filterRepos(repos.value ?? [], query.value);
  const publicOnly = isPublicOnly(repos.value);
  const n = name.value.trim();
  const exists = !!repos.value?.some(
    (r) => r.fullName.toLowerCase() === `${s?.login}/${n}-1`.toLowerCase(),
  );

  return (
    <main class="onboarding">
      <div class="brand-hero">
        <IconCloud size={40} />
        <h1>Name your folder</h1>
      </div>
      <p class="lede">
        Signed in as <b>{s?.login}</b>. nubes keeps your files in private repositories of your
        account, <code>{n || "name"}-1</code>, <code>{n || "name"}-2</code>…, and creates the next
        one when a repository reaches 5 GB. You see one folder.
      </p>
      <form
        class="card form"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label for="pool-name">Name</label>
        <div class="row">
          <input
            id="pool-name"
            value={name.value}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            onInput={(e) => {
              name.value = e.currentTarget.value;
            }}
          />
          <button class="btn primary" type="submit" disabled={pending.value || !n}>
            {pending.value ? "Opening…" : exists ? "Open" : "Create"}
          </button>
        </div>
        <p class="fine">
          {exists
            ? `${n} already exists on your account: its files open here.`
            : "Use the same name on every device to see the same files."}
        </p>
        <label class="check">
          <input
            type="checkbox"
            checked={encrypt.value}
            onChange={(e) => {
              encrypt.value = e.currentTarget.checked;
            }}
          />
          Encrypt the files end to end (a new, empty folder)
        </label>
        {encrypt.value && (
          <>
            <label for="new-pass">Passphrase (10 characters or more)</label>
            <input
              id="new-pass"
              type="password"
              autocomplete="new-password"
              value={pass.value}
              onInput={(e) => {
                pass.value = e.currentTarget.value;
              }}
            />
            <label for="new-pass2">The passphrase again</label>
            <input
              id="new-pass2"
              type="password"
              autocomplete="new-password"
              value={pass2.value}
              onInput={(e) => {
                pass2.value = e.currentTarget.value;
              }}
            />
            <p class="fine">
              Every device asks for it once. Nobody can reset it: without it, the files cannot be
              read back. GitHub sees the file names and sizes, not their contents.
            </p>
          </>
        )}
        {error.value && (
          <p class="error" role="alert">
            {error.value}
          </p>
        )}
      </form>
      <button
        type="button"
        class="btn"
        aria-expanded={existing.value}
        onClick={() => (existing.value = !existing.value)}
      >
        Use an existing repository instead
      </button>
      {existing.value && (
        <div class="card existing">
          {publicOnly && (
            <div class="token-help notice" role="status">
              <p>
                <b>This token only sees public repositories.</b> That is GitHub's default. To use a
                private repository, open{" "}
                <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
                  your fine-grained tokens
                </a>
                , edit this one (or create a new one) and:
              </p>
              <TokenSteps />
              <p>Then reload this page, or sign in with the new token.</p>
            </div>
          )}
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
            <p class="fine">
              One repository, without new ones created for you; the encryption choice above applies.
              The token only sees the repositories it was given: change its “Repository access” on
              GitHub (
              <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
                your fine-grained tokens
              </a>
              ) if yours is missing.
            </p>
          </form>
        </div>
      )}
      <div class="card token-help">
        <p>
          <b>“Cannot create the repository”?</b> The token needs <b>All repositories</b> and the{" "}
          <b>Administration</b> permission (Read and write), on top of Contents. Edit it on GitHub (
          <a href={TOKENS_URL} target="_blank" rel="noopener noreferrer">
            your fine-grained tokens
          </a>
          ), or sign in with another token.
        </p>
        <button type="button" class="btn" onClick={() => void signOut()}>
          Use another token
        </button>
      </div>
    </main>
  );
}
