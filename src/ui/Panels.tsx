/** Dialogs and side panels of the explorer. */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { CommitInfo } from "../github/client";
import type { MemberSize } from "../github/pool";
import {
  chooseRepo,
  clearFinishedUploads,
  describeError,
  dismissToast,
  fetchBlob,
  link,
  locked,
  lockFolder,
  move,
  remote,
  remoteState,
  restoreVersion,
  saveBlob,
  session,
  signOut,
  toast,
  toasts,
  uploads,
} from "../state";
import { deviceName, setDeviceName } from "../store/settings";
import {
  canSyncFolder,
  hasPermission,
  type LinkedFolder,
  linkedFolder,
  linkFolder,
  syncFolder,
  unlinkFolder,
} from "../sync/folder";
import { isAppleTouch } from "./drop";
import { basename, dirname, humanSize, kindOf, mimeOf, timeAgo } from "./format";
import { IconDownload, IconHistory, IconPencil } from "./icons";
import { Modal } from "./Modal";

export function Preview(props: {
  path: string;
  onClose: () => void;
  onHistory: () => void;
  /** Opens the editor on the text shown, which is the file's content `sha`. */
  onEdit?: (text: string, sha: string) => void;
}) {
  const f = remoteState.value?.files.get(props.path);
  const url = useSignal<string | null>(null);
  const text = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const kind = kindOf(props.path);
  useEffect(() => {
    if (!f) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        if (kind === "other") return;
        if (kind === "text") {
          if (f.size > 2 * 1024 * 1024) return;
          const t = await (await fetchBlob(f.sha)).text();
          if (!cancelled) text.value = t;
          return;
        }
        const blob = await fetchBlob(f.sha, mimeOf(props.path));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        url.value = objectUrl;
      } catch (err) {
        error.value = describeError(err);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [f?.sha]);
  if (!f) return null;
  const download = async () => saveBlob(await fetchBlob(f.sha), basename(props.path));
  return (
    <Modal
      title={basename(props.path)}
      wide
      onClose={props.onClose}
      actions={
        <div class="modal-actions">
          {props.onEdit && kind === "text" && text.value !== null && (
            <button
              type="button"
              class="btn ghost"
              onClick={() => props.onEdit?.(text.value ?? "", f.sha)}
            >
              <IconPencil /> Edit
            </button>
          )}
          <button type="button" class="btn ghost" onClick={props.onHistory}>
            <IconHistory /> History
          </button>
          <button type="button" class="btn" onClick={download}>
            <IconDownload /> Download
          </button>
        </div>
      }
    >
      <p class="muted small">
        {humanSize(f.size)}
        {dirname(props.path) ? ` · in ${dirname(props.path)}` : ""}
      </p>
      <div class="preview">
        {error.value ? (
          <p class="error">{error.value}</p>
        ) : kind === "image" && url.value ? (
          <img src={url.value} alt={basename(props.path)} />
        ) : kind === "pdf" && url.value ? (
          <iframe src={url.value} title={basename(props.path)} />
        ) : kind === "video" && url.value ? (
          // biome-ignore lint/a11y/useMediaCaption: user files have no captions
          <video src={url.value} controls />
        ) : kind === "audio" && url.value ? (
          // biome-ignore lint/a11y/useMediaCaption: user files have no captions
          <audio src={url.value} controls />
        ) : kind === "text" && text.value !== null ? (
          <pre>{text.value}</pre>
        ) : kind === "other" || (kind === "text" && f.size > 2 * 1024 * 1024) ? (
          <p class="muted">No preview for this file. Download it to open it.</p>
        ) : (
          <p class="muted">Loading…</p>
        )}
      </div>
    </Modal>
  );
}

export function History(props: { path: string; onClose: () => void }) {
  const commits = useSignal<CommitInfo[] | null>(null);
  const error = useSignal<string | null>(null);
  const r = remote.value;
  const current = remoteState.value?.files.get(props.path)?.sha;
  useEffect(() => {
    if (!r) return;
    r.history(props.path)
      .then((c) => {
        commits.value = c;
      })
      .catch((err) => {
        error.value = describeError(err);
      });
  }, [props.path]);
  const versionAt = async (c: CommitInfo) => {
    if (!r) return null;
    const sha = await r.versionAt(props.path, c.sha);
    if (!sha) toast(`${basename(props.path)} did not exist in that version`, "error");
    return sha;
  };
  return (
    <Modal title={`History of ${basename(props.path)}`} onClose={props.onClose}>
      {error.value && <p class="error">{error.value}</p>}
      {commits.value === null && !error.value && <p class="muted">Loading…</p>}
      {commits.value?.length === 0 && <p class="muted">No history yet.</p>}
      <ul class="history">
        {commits.value?.map((c, i) => (
          <li key={c.sha}>
            <div class="history-main">
              <span class="history-msg">{c.message.split("\n")[0]}</span>
              <span class="muted small">
                {timeAgo(c.date)} · {c.author} · <code>{c.sha.slice(0, 7)}</code>
              </span>
            </div>
            <div class="history-actions">
              <button
                type="button"
                class="btn small"
                onClick={async () => {
                  const sha = await versionAt(c);
                  if (sha) saveBlob(await fetchBlob(sha), basename(props.path));
                }}
              >
                Download
              </button>
              {!(i === 0 && current) && (
                <button
                  type="button"
                  class="btn small"
                  onClick={async () => {
                    const sha = await versionAt(c);
                    if (sha) {
                      await restoreVersion(props.path, sha);
                      props.onClose();
                    }
                  }}
                >
                  Restore
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

export function Rename(props: { path: string; onClose: () => void }) {
  const value = useSignal(props.path);
  const submit = async (e: Event) => {
    e.preventDefault();
    const to = value.value.trim().replace(/^\/+|\/+$/g, "");
    if (!to || to === props.path) return props.onClose();
    props.onClose();
    await move(props.path, to);
  };
  return (
    <Modal title={`Rename or move ${basename(props.path)}`} onClose={props.onClose}>
      <form class="form" onSubmit={submit}>
        <label for="rename">New path (use / to move it to another folder)</label>
        <input
          id="rename"
          autofocus
          value={value.value}
          spellcheck={false}
          autocapitalize="off"
          onInput={(e) => {
            value.value = e.currentTarget.value;
          }}
        />
        <div class="row end">
          <button type="button" class="btn ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            Rename
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewFolder(props: {
  dir: string;
  onCreate: (path: string) => void;
  onClose: () => void;
}) {
  const value = useSignal("");
  return (
    <Modal title="New folder" onClose={props.onClose}>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          const name = value.value.trim().replace(/^\/+|\/+$/g, "");
          if (name) props.onCreate(props.dir ? `${props.dir}/${name}` : name);
          props.onClose();
        }}
      >
        <label for="folder">Name</label>
        <input
          id="folder"
          autofocus
          value={value.value}
          onInput={(e) => {
            value.value = e.currentTarget.value;
          }}
        />
        <p class="fine">
          Git keeps no empty folders: it is saved with the first file you put in it.
        </p>
        <div class="row end">
          <button type="button" class="btn ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Confirm(props: {
  title: string;
  body: string;
  action: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <p>{props.body}</p>
      <div class="row end">
        <button type="button" class="btn ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button
          type="button"
          class="btn danger"
          onClick={() => {
            props.onClose();
            props.onConfirm();
          }}
        >
          {props.action}
        </button>
      </div>
    </Modal>
  );
}

/** GitHub's advice: a repository ideally under 1 GB, and under 5 GB. */
export const SIZE_SOFT = 1024 ** 3;
export const SIZE_HARD = 5 * 1024 ** 3;

/** The repository's size against GitHub's recommended limits; for a pool, each repository against its limit. */
function Storage() {
  const sizes = useSignal<MemberSize[] | null>(null);
  const r = remote.value;
  const pool = link.value?.pool;
  useEffect(() => {
    if (!r) return;
    r.sizes().then(
      (s) => {
        sizes.value = s;
      },
      () => {},
    );
  }, [r]);
  if (sizes.value === null || sizes.value.length === 0) return null;
  if (pool) return <PoolStorage sizes={sizes.value} max={pool.maxSize} />;
  const n = (sizes.value[0] as MemberSize).size;
  const level = n >= SIZE_HARD ? "over" : n >= SIZE_SOFT ? "warn" : "ok";
  return (
    <div class={`storage storage-${level}`}>
      <div class="row between">
        <b>Storage</b>
        <span>
          {humanSize(n)} <span class="muted">of 5 GB recommended</span>
        </span>
      </div>
      {/* The figure above says it in words; the bar only shows it. */}
      <div class="gauge" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (n / SIZE_HARD) * 100)}%` }} />
        <i style={{ left: `${(SIZE_SOFT / SIZE_HARD) * 100}%` }} title="1 GB" />
      </div>
      <p class="fine">
        {level === "ok"
          ? "GitHub recommends staying under 1 GB (marked), and under 5 GB. Every version is kept, so deleted files still count."
          : level === "warn"
            ? "Warning: over 1 GB. GitHub recommends staying under 5 GB: consider a second repository (or a folder of another one) for large files such as videos."
            : "Over 5 GB: GitHub may ask you to reduce this repository. Move large files to another repository."}{" "}
        GitHub updates this figure a while after changes.
      </p>
    </div>
  );
}

/** A pool: one gauge per repository. A full one is expected, new files go to the next. */
function PoolStorage(props: { sizes: MemberSize[]; max: number }) {
  const total = props.sizes.reduce((n, m) => n + m.size, 0);
  const count = props.sizes.length;
  return (
    <div class="storage">
      <div class="row between">
        <b>Storage</b>
        <span>
          {humanSize(total)}{" "}
          <span class="muted">
            in {count} {count === 1 ? "repository" : "repositories"}
          </span>
        </span>
      </div>
      <ul class="storage-members">
        {props.sizes.map((m) => (
          <li key={m.repo} class="storage-member">
            <div class="row between small">
              <a href={`https://github.com/${m.repo}`} target="_blank" rel="noopener noreferrer">
                {m.repo.split("/")[1]}
              </a>
              <span>
                {humanSize(m.size)} <span class="muted">of {humanSize(props.max)}</span>
                {m.size >= props.max && <span class="muted"> · full</span>}
              </span>
            </div>
            <div class="gauge" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (m.size / props.max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p class="fine">
        When a repository reaches {humanSize(props.max)}, new files go to the next one, created
        automatically (private). Edits stay in the repository that holds the file. Every version is
        kept, so deleted files still count; GitHub updates these figures a while after changes.
      </p>
    </div>
  );
}

export function Settings(props: { onClose: () => void }) {
  const device = useSignal(deviceName());
  const l = link.value;
  return (
    <Modal title="Settings" onClose={props.onClose}>
      <div class="form">
        <p>
          Signed in as <b>{session.value?.login}</b>
          {l?.pool && (
            <>
              {" "}
              · <b>{l.pool.name}</b>, in the private repositories{" "}
              <code>
                {l.pool.owner}/{l.pool.name}-1, -2…
              </code>
            </>
          )}
          {l && !l.pool && (
            <>
              {" "}
              · repository{" "}
              <a
                href={`https://github.com/${l.repo}/tree/${encodeURIComponent(l.branch)}/${l.prefix}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {l.repo}
                {l.prefix ? `:${l.prefix}` : ""}
              </a>{" "}
              ({l.branch})
            </>
          )}
        </p>
        <label for="device">Name of this device (in commit messages and conflict copies)</label>
        <input
          id="device"
          value={device.value}
          onInput={(e) => {
            device.value = e.currentTarget.value;
          }}
          onBlur={() => setDeviceName(device.value)}
        />
        <div class="row">
          <button
            type="button"
            class="btn"
            onClick={() => {
              props.onClose();
              void chooseRepo(null);
            }}
          >
            Use another repository
          </button>
          <button
            type="button"
            class="btn danger"
            onClick={() => {
              props.onClose();
              void signOut();
            }}
          >
            Sign out
          </button>
        </div>
        {remoteState.value?.encrypted && (
          <div class="row between">
            <span>
              <b>Encrypted end to end.</b>{" "}
              <span class="muted">File names are visible on GitHub, their contents are not.</span>
            </span>
            {!locked.value && (
              <button
                type="button"
                class="btn small"
                onClick={() => {
                  lockFolder();
                  props.onClose();
                }}
              >
                Forget the key here
              </button>
            )}
          </div>
        )}
        <Storage />
        <h3>Other devices</h3>
        <ul class="tips">
          <li>
            <b>iPad, iPhone, any browser:</b> open this page, sign in with a token. Changes from
            other devices show up within 30 seconds, or when you come back to the tab.
          </li>
          <li>
            <b>Mac, Linux:</b> <code>brew install maxgfr/tap/nubes</code>, then{" "}
            <code>nubes init {l?.pool?.name ?? l?.repo ?? "owner/repo"}</code> and{" "}
            <code>nubes service install</code> in the folder: it stays in sync in the background.
          </li>
          <li>
            <b>Without a network:</b> files you add wait on this device and are sent when it comes
            back. A folder marked “Keep offline” (in its menu) opens without a network.
          </li>
          <li>
            <b>A folder in the Files app (iPad):</b> Safari cannot keep a folder in sync. The
            repository is plain git, so a git app such as Working Copy can clone it into Files and
            pull/push it.
          </li>
        </ul>
      </div>
    </Modal>
  );
}

const STATUS: Record<string, string> = {
  queued: "Waiting",
  hashing: "Checking",
  uploading: "Uploading",
  ready: "Ready",
  committing: "Saving",
  done: "Saved",
  unchanged: "Unchanged",
  skipped: "Skipped",
  pending: "Waiting for the network",
  error: "Failed",
};

export function UploadPanel() {
  const list = uploads.value;
  if (list.length === 0) return null;
  const active = list.filter(
    (u) => !["done", "unchanged", "skipped", "error", "pending"].includes(u.status),
  );
  const failed = list.filter((u) => u.status === "error").length;
  const waiting = list.filter((u) => u.status === "pending").length;
  return (
    <section class="uploads card" aria-live="polite">
      <header>
        <b>
          {active.length > 0
            ? `Uploading ${list.length - active.length}/${list.length}`
            : failed > 0
              ? `${failed} upload${failed === 1 ? "" : "s"} failed`
              : waiting > 0
                ? `Offline: ${waiting} file${waiting === 1 ? "" : "s"} will be sent when back online`
                : "All uploads saved"}
        </b>
        {active.length === 0 && (
          <button type="button" class="btn small ghost" onClick={clearFinishedUploads}>
            Clear
          </button>
        )}
      </header>
      <ul>
        {list.slice(-200).map((u) => (
          <li key={u.id} class={`up up-${u.status}`}>
            <span class="up-name">{u.path}</span>
            <span class="up-status">
              {STATUS[u.status]}
              {u.note ? `: ${u.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <button
          type="button"
          key={t.id}
          class={`toast toast-${t.tone}`}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

const AUTO_MS = 30_000;
/** Files already reported as too large to upload, during this visit. */
const reportedTooLarge = new Set<string>();

/** Two-way sync of a local folder (Chromium desktop only). */
export function FolderSync() {
  const r = remote.value;
  const linked = useSignal<LinkedFolder | null>(null);
  const status = useSignal<string | null>(null);
  const auto = useSignal(false);
  useEffect(() => {
    if (!r) return;
    void linkedFolder(r).then((l) => {
      linked.value = l ?? null;
    });
  }, [r]);
  const run = async (ask: boolean) => {
    const l = linked.value;
    if (!r || !l || status.value) return;
    try {
      if (!(await hasPermission(l, ask))) {
        if (ask) toast("nubes needs permission to write in that folder", "error");
        auto.value = false;
        return;
      }
      const res = await syncFolder(r, l, deviceName(), (t) => {
        status.value = t;
      });
      const s = res.plan.summary;
      const n = s.uploads + s.downloads + s.deleteLocal + s.deleteRemote + s.conflicts;
      const big = res.plan.actions.flatMap((a) =>
        a.op === "skip" && a.reason === "tooLarge" ? [a.path] : [],
      );
      // Automatic runs mention a too-large file once; a manual sync, always.
      const fresh = big.filter((p) => ask || !reportedTooLarge.has(p));
      for (const p of big) reportedTooLarge.add(p);
      if (n > 0 || ask)
        toast(
          n === 0
            ? `${l.name} is up to date`
            : `${l.name}: ${s.uploads} up, ${s.downloads} down, ${s.deleteLocal + s.deleteRemote} deleted${s.conflicts ? `, ${s.conflicts} conflict copies` : ""}`,
        );
      if (fresh.length > 0)
        toast(
          `Not uploaded, over GitHub's 100 MB per-file limit: ${fresh.slice(0, 3).map(basename).join(", ")}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ""}`,
          "error",
        );
      linked.value = { ...l };
      if (res.committed || s.downloads > 0) {
        const { refresh } = await import("../state");
        await refresh(true);
      }
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      status.value = null;
    }
  };
  useEffect(() => {
    if (!auto.value) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void run(false);
    }, AUTO_MS);
    return () => clearInterval(t);
  }, [auto.value]);

  if (!r) return null;
  if (!canSyncFolder()) {
    return isAppleTouch() ? (
      <p class="hint">
        On iPad, add files with <b>Upload</b> or by dragging them from the Files app. Everything you
        add here appears on your other devices.
      </p>
    ) : null;
  }
  const l = linked.value;
  return (
    <section class="folder-sync card">
      {l ? (
        <>
          <div>
            <b>Local folder “{l.name}”</b>
            <span class="muted small">
              {" "}
              ·{" "}
              {l.lastSync
                ? `synced ${timeAgo(new Date(l.lastSync).toISOString())}`
                : "never synced"}
            </span>
          </div>
          <div class="row">
            <label class="check">
              <input
                type="checkbox"
                checked={auto.value}
                onChange={async (e) => {
                  auto.value = e.currentTarget.checked;
                  if (auto.value) await run(true);
                }}
              />
              Keep in sync while open
            </label>
            <button type="button" class="btn" disabled={!!status.value} onClick={() => run(true)}>
              {status.value ?? "Sync now"}
            </button>
            <button
              type="button"
              class="btn ghost"
              onClick={async () => {
                await unlinkFolder(r);
                linked.value = null;
                auto.value = false;
              }}
            >
              Unlink
            </button>
          </div>
        </>
      ) : (
        <>
          <div>
            <b>Sync a folder of this computer</b>
            <span class="muted small"> · two-way, like the CLI, while this tab is open</span>
          </div>
          <button
            type="button"
            class="btn"
            onClick={async () => {
              try {
                linked.value = await linkFolder(r);
                await run(true);
              } catch (err) {
                if ((err as Error).name !== "AbortError") toast(describeError(err), "error");
              }
            }}
          >
            Choose a folder…
          </button>
        </>
      )}
    </section>
  );
}
