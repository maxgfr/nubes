/** Sign in with a fine-grained token, then name the folder (or pick a repository). */
import { useSignal } from "@preact/signals";
import { describeError, signIn } from "../state";
import { TOKEN_URL } from "../store/settings";
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
        Your files in private GitHub repositories you own. Drop them here from any device, sync a
        folder from the terminal, and every version stays in the history. No server in between: this
        page talks to GitHub directly.
      </p>
      <ol class="steps">
        <li>
          <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer">
            Create a fine-grained token
          </a>
          : <TokenSteps />
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

/**
 * What to do on GitHub's “new fine-grained token” page, which ignores
 * pre-filling parameters: the defaults (public repositories, no
 * permission) give a token nubes cannot use.
 */
export function TokenSteps() {
  return (
    <ol class="token-steps">
      <li>Give it a name (“nubes”) and an expiration.</li>
      <li>
        Under <b>Repository access</b>, choose <b>All repositories</b>: nubes creates private
        repositories for your files as they fill up. (To use one repository of yours instead, choose{" "}
        <b>Only select repositories</b> and pick it.)
      </li>
      <li>
        Under <b>Permissions</b>, click <b>Add permissions</b>, check <b>Contents</b> and set it to{" "}
        <b>Read and write</b>. With All repositories, also check <b>Administration</b>, set to{" "}
        <b>Read and write</b> (to create the repositories).
      </li>
      <li>
        <b>Generate token</b> and copy it.
      </li>
    </ol>
  );
}

/**
 * A token that lists repositories but no private one was most likely left
 * on GitHub's default “Public repositories” access.
 */
export function isPublicOnly(repos: { private: boolean }[] | null): boolean {
  return !!repos && repos.length > 0 && repos.every((r) => !r.private);
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
