/**
 * Panels of everyday use: activity, recently deleted, the text editor,
 * the photo viewer and the "move to" dialog.
 */
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
  type Deleted,
  deletedFiles,
  deviceOf,
  RECENT,
  type RecentCommit,
  recentCommits,
  relative,
} from "../changes";
import type { CommitInfo } from "../github/client";
import {
  describeError,
  downloadFile,
  fetchBlob,
  moveInto,
  remote,
  remoteState,
  restoreDeleted,
  saveText,
} from "../state";
import { basename, dirname, humanSize, mimeOf, timeAgo } from "./format";
import { IconChevron, IconDownload, IconImage } from "./icons";
import type { Row } from "./listing";
import { Modal } from "./Modal";

/** The latest commits, by device ("(from ipad)" in the messages). */
export function Activity(props: { onClose: () => void }) {
  const commits = useSignal<CommitInfo[] | null>(null);
  const error = useSignal<string | null>(null);
  const device = useSignal<string | null>(null);
  const open = useSignal<string | null>(null);
  const files = useSignal<Record<string, RecentCommit["files"]>>({});
  const r = remote.value;
  useEffect(() => {
    if (!r) return;
    r.gh
      .history(r.target.full, r.target.branch, r.prefix, 1, 50)
      .then((c) => {
        commits.value = c;
      })
      .catch((err) => {
        error.value = describeError(err);
      });
  }, [r]);
  const list = commits.value ?? [];
  const devices = [...new Set(list.map((c) => deviceOf(c.message) ?? "other"))];
  const shown = device.value
    ? list.filter((c) => (deviceOf(c.message) ?? "other") === device.value)
    : list;
  const toggle = async (c: CommitInfo) => {
    open.value = open.value === c.sha ? null : c.sha;
    if (!r || files.value[c.sha]) return;
    try {
      const f = await r.gh.commitFiles(r.target.full, c.sha);
      files.value = { ...files.value, [c.sha]: f.files };
    } catch (err) {
      error.value = describeError(err);
    }
  };
  return (
    <Modal title="Activity" onClose={props.onClose}>
      {error.value && <p class="error">{error.value}</p>}
      {commits.value === null && !error.value && <p class="muted">Loading…</p>}
      {devices.length > 1 && (
        <fieldset class="chips">
          <legend class="visually-hidden">Device</legend>
          <button
            type="button"
            class="chip"
            aria-pressed={device.value === null}
            onClick={() => (device.value = null)}
          >
            All
          </button>
          {devices.map((d) => (
            <button
              key={d}
              type="button"
              class="chip"
              aria-pressed={device.value === d}
              onClick={() => (device.value = d)}
            >
              {d}
            </button>
          ))}
        </fieldset>
      )}
      <ul class="history activity">
        {shown.map((c) => (
          <li key={c.sha}>
            <button
              type="button"
              class="activity-main"
              aria-expanded={open.value === c.sha}
              onClick={() => toggle(c)}
            >
              <span class="tag">{deviceOf(c.message) ?? "other"}</span>
              <span class="history-msg">
                {c.message
                  .split("\n")[0]
                  ?.replace(/^nubes: /, "")
                  .replace(/ \(from [^)]+\)$/, "")}
              </span>
              <span class="muted small">{timeAgo(c.date)}</span>
            </button>
            {open.value === c.sha && (
              <ul class="activity-files small">
                {files.value[c.sha] === undefined ? (
                  <li class="muted">Loading…</li>
                ) : (
                  (files.value[c.sha] ?? []).map((f) => {
                    const p = relative(r?.prefix ?? "", f.path);
                    return p ? (
                      <li key={f.path}>
                        <span class={`change change-${f.status}`}>{f.status}</span> {p}
                      </li>
                    ) : null;
                  })
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Files deleted in the latest commits, restorable without uploading them again. */
export function Trash(props: { onClose: () => void }) {
  const items = useSignal<Deleted[] | null>(null);
  const error = useSignal<string | null>(null);
  const r = remote.value;
  const head = remoteState.value?.head;
  useEffect(() => {
    if (!r) return;
    recentCommits(r)
      .then((c) => {
        items.value = deletedFiles(c, r.prefix, remoteState.value?.files ?? new Map());
      })
      .catch((err) => {
        error.value = describeError(err);
      });
  }, [r, head]);
  return (
    <Modal title="Recently deleted" onClose={props.onClose}>
      <p class="muted small">
        Files deleted in the last {RECENT} changes, from any device. Restoring one brings it back
        everywhere.
      </p>
      {error.value && <p class="error">{error.value}</p>}
      {items.value === null && !error.value && <p class="muted">Looking through the history…</p>}
      {items.value?.length === 0 && <p class="muted">Nothing deleted recently.</p>}
      <ul class="history">
        {items.value?.map((d) => (
          <li key={d.path}>
            <div class="history-main">
              <span class="history-msg">{d.path}</span>
              <span class="muted small">deleted {timeAgo(d.date)}</span>
            </div>
            <div class="history-actions">
              <button
                type="button"
                class="btn small"
                onClick={async () => {
                  if (await restoreDeleted(d.path, d.before))
                    items.value = (items.value ?? []).filter((x) => x.path !== d.path);
                }}
              >
                Restore
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** A plain-text editor; saving makes one commit (or a conflict copy if it changed meanwhile). */
export function Editor(props: {
  path: string;
  /** The content's blob id when editing began, null for a new file. */
  baseSha: string | null;
  initial: string;
  onClose: () => void;
}) {
  const text = useSignal(props.initial);
  const saving = useSignal(false);
  const leaving = useSignal(false);
  const dirty = text.value !== props.initial;
  const save = async () => {
    saving.value = true;
    const where = await saveText(props.path, props.baseSha, text.value);
    saving.value = false;
    if (where) props.onClose();
  };
  return (
    <Modal
      title={basename(props.path)}
      wide
      onClose={() => {
        // Unsaved text is never dropped on a stray Escape or backdrop tap.
        if (dirty && !leaving.value) leaving.value = true;
        else props.onClose();
      }}
      actions={
        <div class="modal-actions">
          <button
            type="button"
            class="btn primary"
            disabled={saving.value || (!dirty && props.baseSha !== null)}
            onClick={save}
          >
            {saving.value ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      {leaving.value && (
        <div class="row discard" role="alert">
          <span>Your changes are not saved.</span>
          <button type="button" class="btn small danger" onClick={props.onClose}>
            Discard
          </button>
          <button type="button" class="btn small" onClick={() => (leaving.value = false)}>
            Keep editing
          </button>
        </div>
      )}
      <form
        class="editor"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label class="visually-hidden" for="editor">
          Content of {basename(props.path)}
        </label>
        <textarea
          id="editor"
          autofocus
          spellcheck
          value={text.value}
          onInput={(e) => {
            text.value = e.currentTarget.value;
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </form>
      <p class="muted small">
        {dirname(props.path) ? `In ${dirname(props.path)} · ` : ""}⌘S saves. If the file changes on
        another device meanwhile, your text is kept as a conflict copy beside it.
      </p>
    </Modal>
  );
}

/** Thumbnails are full images (GitHub makes no smaller ones): only those under this size load. */
export const THUMB_MAX = 8 * 1024 * 1024;

/** An image's thumbnail, loaded once it scrolls into view. */
export function Thumb(props: { row: Row }) {
  const ref = useRef<HTMLDivElement>(null);
  const url = useSignal<string | null>(null);
  const { row } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el || !row.sha || row.size > THUMB_MAX) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    const load = () => {
      void fetchBlob(row.sha as string, mimeOf(row.path)).then(
        (b) => {
          if (cancelled) return;
          objectUrl = URL.createObjectURL(b);
          url.value = objectUrl;
        },
        () => {},
      );
    };
    if (typeof IntersectionObserver === "undefined") load();
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((e) => e.isIntersecting)) {
                io?.disconnect();
                load();
              }
            },
            { rootMargin: "200px" },
          );
    io?.observe(el);
    return () => {
      cancelled = true;
      io?.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [row.sha]);
  return (
    <div class="thumb" ref={ref}>
      {url.value ? (
        <img
          src={url.value}
          alt=""
          draggable={false}
          // A format the browser cannot show (HEIC outside Safari): the icon instead.
          onError={() => {
            url.value = null;
          }}
        />
      ) : (
        <IconImage size={32} />
      )}
    </div>
  );
}

/** Full-screen photos: arrows, keys or a swipe go from one to the next. */
export function Viewer(props: { images: Row[]; start: number; onClose: () => void }) {
  const index = useSignal(props.start);
  const url = useSignal<string | null>(null);
  const error = useSignal<string | null>(null);
  const touch = useRef<number | null>(null);
  const row = props.images[index.value];
  const go = (d: number) => {
    const n = props.images.length;
    index.value = (index.value + d + n) % n;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!row?.sha) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    url.value = null;
    error.value = null;
    fetchBlob(row.sha, mimeOf(row.path)).then(
      (b) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(b);
        url.value = objectUrl;
      },
      (err) => {
        error.value = describeError(err);
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [row?.sha]);
  if (!row) return null;
  const many = props.images.length > 1;
  return (
    <Modal
      title={row.name}
      wide
      onClose={props.onClose}
      actions={
        <div class="modal-actions">
          <button type="button" class="btn" onClick={() => void downloadFile(row.path)}>
            <IconDownload /> Download
          </button>
        </div>
      }
    >
      <div
        class="viewer"
        onPointerDown={(e) => {
          touch.current = e.clientX;
        }}
        onPointerUp={(e) => {
          const from = touch.current;
          touch.current = null;
          if (from === null || !many) return;
          const dx = e.clientX - from;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        }}
      >
        {error.value ? (
          <p class="error">{error.value}</p>
        ) : url.value ? (
          <img src={url.value} alt={row.name} draggable={false} />
        ) : (
          <p class="muted">Loading…</p>
        )}
      </div>
      <div class="viewer-bar">
        {many && (
          <button type="button" class="icon-btn flip" aria-label="Previous" onClick={() => go(-1)}>
            <IconChevron />
          </button>
        )}
        <span class="muted small">
          {many ? `${index.value + 1} / ${props.images.length} · ` : ""}
          {humanSize(row.size)}
        </span>
        {many && (
          <button type="button" class="icon-btn" aria-label="Next" onClick={() => go(1)}>
            <IconChevron />
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Names a new text note, then opens it in the editor. */
export function NewNote(props: {
  dir: string;
  onCreate: (path: string) => void;
  onClose: () => void;
}) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const value = useSignal(`Note ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`);
  const error = useSignal<string | null>(null);
  return (
    <Modal title="New note" onClose={props.onClose}>
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          const name = value.value.trim().replace(/^\/+|\/+$/g, "");
          if (!name) return;
          const path = props.dir ? `${props.dir}/${name}` : name;
          if (remoteState.value?.files.has(path)) {
            error.value = `${name} already exists here.`;
            return;
          }
          props.onCreate(path);
        }}
      >
        <label for="note-name">Name</label>
        <input
          id="note-name"
          autofocus
          value={value.value}
          spellcheck={false}
          onInput={(e) => {
            value.value = e.currentTarget.value;
          }}
        />
        {error.value && (
          <p class="error" role="alert">
            {error.value}
          </p>
        )}
        <div class="row end">
          <button type="button" class="btn ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            Write
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Where to move the selected items. */
export function MoveTo(props: { paths: string[]; dir: string; onClose: () => void }) {
  const value = useSignal(props.dir);
  const folders = [
    ...new Set(
      [...(remoteState.value?.files.keys() ?? [])].flatMap((p) => {
        const parts = p.split("/").slice(0, -1);
        return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      }),
    ),
  ].sort();
  return (
    <Modal
      title={`Move ${props.paths.length} item${props.paths.length === 1 ? "" : "s"}`}
      onClose={props.onClose}
    >
      <form
        class="form"
        onSubmit={(e) => {
          e.preventDefault();
          props.onClose();
          void moveInto(props.paths, value.value.trim().replace(/^\/+|\/+$/g, ""));
        }}
      >
        <label for="move-to">To the folder (empty for the top folder)</label>
        <input
          id="move-to"
          list="move-folders"
          autofocus
          value={value.value}
          spellcheck={false}
          autocapitalize="off"
          onInput={(e) => {
            value.value = e.currentTarget.value;
          }}
        />
        <datalist id="move-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <div class="row end">
          <button type="button" class="btn ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn primary">
            Move
          </button>
        </div>
      </form>
    </Modal>
  );
}
