/** Dialogs and side panels of the explorer. */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type { CommitInfo } from "../github/client";
import {
  chooseRepo,
  clearFinishedUploads,
  describeError,
  dismissToast,
  fetchBlob,
  link,
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
import { IconDownload, IconHistory } from "./icons";
import { Modal } from "./Modal";

export function Preview(props: { path: string; onClose: () => void; onHistory: () => void }) {
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
    r.gh
      .history(r.target.full, r.target.branch, r.full(props.path))
      .then((c) => {
        commits.value = c;
      })
      .catch((err) => {
        error.value = describeError(err);
      });
  }, [props.path]);
  const versionAt = async (c: CommitInfo) => {
    if (!r) return null;
    const sha = await r.gh.fileAt(r.target.full, r.full(props.path), c.sha);
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

export function Settings(props: { onClose: () => void }) {
  const device = useSignal(deviceName());
  const l = link.value;
  return (
    <Modal title="Settings" onClose={props.onClose}>
      <div class="form">
        <p>
          Signed in as <b>{session.value?.login}</b>
          {l && (
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
        <h3>Other devices</h3>
        <ul class="tips">
          <li>
            <b>iPad, iPhone, any browser:</b> open this page, sign in with a token. Changes from
            other devices show up within 30 seconds, or when you come back to the tab.
          </li>
          <li>
            <b>Mac, Linux:</b> <code>brew install maxgfr/tap/nubes</code>, then{" "}
            <code>nubes init {l?.repo ?? "owner/repo"}</code> and <code>nubes watch</code> in the
            folder to keep in sync.
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
  error: "Failed",
};

export function UploadPanel() {
  const list = uploads.value;
  if (list.length === 0) return null;
  const active = list.filter((u) => !["done", "unchanged", "skipped", "error"].includes(u.status));
  const failed = list.filter((u) => u.status === "error").length;
  return (
    <section class="uploads card" aria-live="polite">
      <header>
        <b>
          {active.length > 0
            ? `Uploading ${list.length - active.length}/${list.length}`
            : failed > 0
              ? `${failed} upload${failed === 1 ? "" : "s"} failed`
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
      if (n > 0 || ask)
        toast(
          n === 0
            ? `${l.name} is up to date`
            : `${l.name}: ${s.uploads} up, ${s.downloads} down, ${s.deleteLocal + s.deleteRemote} deleted${s.conflicts ? `, ${s.conflicts} conflict copies` : ""}`,
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
