/**
 * The file browser: breadcrumbs, search, folder listing (list or grid),
 * selection, uploads (drag and drop, paste, camera).
 */
import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { changeDates, recentCommits } from "../changes";
import {
  addDraftDir,
  busy,
  cwd,
  downloadFile,
  downloadSelection,
  downloadZip,
  draftDirs,
  lastChecked,
  link,
  loading,
  locked,
  online,
  pendingCount,
  pinStatus,
  pins,
  refresh,
  remote,
  remoteState,
  remove,
  setPinned,
  startPolling,
  upload,
} from "../state";
import { isPinned } from "../store/offline";
import { canPickFolder, capturedName, filesFromDrop, filesFromInput, isAppleTouch } from "./drop";
import { Activity, Editor, MoveTo, NewNote, Thumb, Trash, Unlock, Viewer } from "./Feeds";
import { dirname, humanSize, kindOf, timeAgo } from "./format";
import {
  IconActivity,
  IconCamera,
  IconCheck,
  IconChevron,
  IconCloud,
  IconDownload,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconGrid,
  IconHistory,
  IconImage,
  IconList,
  IconMore,
  IconNote,
  IconPencil,
  IconRefresh,
  IconSelect,
  IconTrash,
  IconUpload,
} from "./icons";
import { listDir, type Row, type SortBy, searchFiles, sortRows, totals } from "./listing";
import {
  Confirm,
  FolderSync,
  History,
  NewFolder,
  Preview,
  Rename,
  Settings,
  UploadPanel,
} from "./Panels";

type Dialog =
  | { kind: "preview"; path: string }
  | { kind: "history"; path: string }
  | { kind: "rename"; path: string }
  | { kind: "delete"; row: Row }
  | { kind: "deleteMany"; paths: string[] }
  | { kind: "moveTo"; paths: string[] }
  | { kind: "edit"; path: string; baseSha: string | null; initial: string }
  | { kind: "viewer"; images: Row[]; start: number }
  | { kind: "activity" }
  | { kind: "trash" }
  | { kind: "newNote" }
  | { kind: "newFolder" }
  | { kind: "settings" };

function Breadcrumbs() {
  const parts = cwd.value ? cwd.value.split("/") : [];
  const repo = link.value?.repo.split("/")[1] ?? "files";
  return (
    <nav class="crumbs" aria-label="Folder">
      <button type="button" class="crumb" onClick={() => (cwd.value = "")}>
        {repo}
      </button>
      {parts.map((p, i) => (
        <span key={parts.slice(0, i + 1).join("/")} class="crumb-wrap">
          <IconChevron size={14} />
          <button
            type="button"
            class="crumb"
            aria-current={i === parts.length - 1 ? "page" : undefined}
            onClick={() => (cwd.value = parts.slice(0, i + 1).join("/"))}
          >
            {p}
          </button>
        </span>
      ))}
    </nav>
  );
}

function SyncBadge() {
  const ago = useSignal(0);
  useEffect(() => {
    const t = setInterval(() => (ago.value = Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  void ago.value;
  const label = !online.value
    ? "Offline"
    : busy.value
      ? busy.value
      : loading.value
        ? "Checking…"
        : pinStatus.value
          ? pinStatus.value
          : lastChecked.value
            ? "Up to date"
            : "Connecting…";
  const tone = !online.value
    ? "warn"
    : busy.value || loading.value || pinStatus.value
      ? "busy"
      : "ok";
  const waiting = pendingCount.value;
  return (
    <>
      <span
        class={`badge badge-${tone}`}
        title={
          lastChecked.value ? `Checked ${new Date(lastChecked.value).toLocaleTimeString()}` : ""
        }
      >
        <span class="dot" />
        {label}
      </span>
      {waiting > 0 && (
        <span class="badge badge-warn" title="Added offline, sent when the network is back">
          <span class="dot" />
          {waiting} waiting to upload
        </span>
      )}
    </>
  );
}

function RowMenu(props: { row: Row; open: (d: Dialog) => void; close: () => void }) {
  const { row } = props;
  const act = (fn: () => void) => () => {
    props.close();
    fn();
  };
  return (
    <div class="menu" role="menu">
      {row.kind === "file" ? (
        <>
          <button type="button" role="menuitem" onClick={act(() => void downloadFile(row.path))}>
            <IconDownload size={18} /> Download
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => props.open({ kind: "history", path: row.path }))}
          >
            <IconHistory size={18} /> History
          </button>
        </>
      ) : (
        <>
          <button type="button" role="menuitem" onClick={act(() => void downloadZip(row.path))}>
            <IconDownload size={18} /> Download as zip
          </button>
          {row.count > 0 &&
            (pins.value.includes(row.path) ? (
              <button type="button" role="menuitem" onClick={act(() => setPinned(row.path, false))}>
                <IconCloud size={18} /> Stop keeping offline
              </button>
            ) : (
              !isPinned(pins.value, row.path) && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={act(() => setPinned(row.path, true))}
                >
                  <IconCloud size={18} /> Keep offline
                </button>
              )
            ))}
        </>
      )}
      {row.count > 0 || row.kind === "file" ? (
        <button
          type="button"
          role="menuitem"
          onClick={act(() => props.open({ kind: "rename", path: row.path }))}
        >
          <IconPencil size={18} /> Rename or move
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        class="danger"
        onClick={act(() => props.open({ kind: "delete", row }))}
      >
        <IconTrash size={18} /> Delete
      </button>
    </div>
  );
}

function FileIcon({ row }: { row: Row }) {
  if (row.kind === "folder") return <IconFolder class="ic-folder" />;
  return kindOf(row.name) === "image" ? (
    <IconImage class="ic-file" />
  ) : (
    <IconFile class="ic-file" />
  );
}

function useStored<T extends string>(key: string, values: readonly T[], fallback: T) {
  const v = useSignal<T>(fallback);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      if (saved && values.includes(saved)) v.value = saved;
    } catch {
      // No storage: the default it is.
    }
  }, []);
  const set = (next: T) => {
    v.value = next;
    try {
      localStorage.setItem(key, next);
    } catch {
      // Not kept, fine.
    }
  };
  return [v, set] as const;
}

/** Touch screens get the camera button (iPad, phones). */
const isTouch = () =>
  isAppleTouch() || (globalThis.matchMedia?.("(pointer: coarse)").matches ?? false);

export function Explorer() {
  const dialog = useSignal<Dialog | null>(null);
  const menu = useSignal<string | null>(null);
  const dragging = useSignal(false);
  const query = useSignal("");
  const [sortBy, setSortBy] = useStored<SortBy>("nubes.sort.v1", ["name", "size", "date"], "name");
  const [view, setView] = useStored<"list" | "grid">("nubes.view.v1", ["list", "grid"], "list");
  const selecting = useSignal(false);
  const selected = useSignal<Set<string>>(new Set());
  const dates = useSignal<Map<string, string> | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => startPolling(), []);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".row-more, .menu")) menu.value = null;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  // ⌘V with an image (a screenshot, a photo copied from Photos) uploads it here.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as Element | null;
      if (
        t?.closest?.("input, textarea, [contenteditable]") ||
        document.querySelector("dialog[open]")
      )
        return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      void upload(files.map((f, i) => ({ path: capturedName(f, "Pasted", i), file: f })));
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // A folder that vanished (deleted elsewhere) sends the view to the nearest parent that exists.
  useEffect(() => {
    const s = remoteState.value;
    if (!s || !cwd.value) return;
    const prefix = `${cwd.value}/`;
    const exists =
      [...s.files.keys()].some((p) => p.startsWith(prefix)) ||
      [...draftDirs.value].some((d) => d === cwd.value || d.startsWith(prefix));
    if (!exists) cwd.value = "";
  }, [remoteState.value]);

  // Dates come from the recent history: read when sorting by date, again when the branch moves.
  const head = remoteState.value?.head;
  useEffect(() => {
    const r = remote.value;
    if (sortBy.value !== "date" || !r) return;
    let cancelled = false;
    recentCommits(r).then(
      (c) => {
        if (!cancelled) dates.value = changeDates(c, (p) => r.nubesPath(p));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sortBy.value, head]);

  // Leaving a folder or a search ends the selection.
  useEffect(() => {
    selected.value = new Set();
  }, [cwd.value, query.value]);

  const searching = query.value.trim() !== "";
  const rows = useComputed(() => {
    const s = remoteState.value;
    if (!s) return [];
    const q = query.value.trim();
    const list = q ? searchFiles(s.files, q) : listDir(s.files, cwd.value, draftDirs.value);
    return sortRows(list, sortBy.value, dates.value ?? undefined);
  });

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    dragging.value = false;
    if (!e.dataTransfer) return;
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) void upload(files);
  };

  const s = remoteState.value;
  const here = s
    ? totals(new Map([...s.files].filter(([p]) => !cwd.value || p.startsWith(`${cwd.value}/`))))
    : null;
  const d = dialog.value;
  const open = (x: Dialog) => {
    dialog.value = x;
  };
  const close = () => {
    dialog.value = null;
  };
  const sel = selected.value;
  const touch = isTouch();
  const toggle = (path: string) => {
    const next = new Set(sel);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    selected.value = next;
  };
  const endSelection = () => {
    selecting.value = false;
    selected.value = new Set();
  };
  const images = rows.value.filter((r) => r.kind === "file" && kindOf(r.name) === "image");
  const activate = (row: Row) => {
    if (selecting.value) return toggle(row.path);
    if (row.kind === "folder") {
      query.value = "";
      cwd.value = row.path;
    } else if (view.value === "grid" && kindOf(row.name) === "image") {
      open({ kind: "viewer", images, start: images.indexOf(row) });
    } else open({ kind: "preview", path: row.path });
  };
  const meta = (row: Row) => {
    if (row.kind === "folder")
      return row.count === 0
        ? "empty"
        : `${row.count} file${row.count === 1 ? "" : "s"} · ${humanSize(row.size)}`;
    const date = sortBy.value === "date" ? dates.value?.get(row.path) : undefined;
    return date ? `${humanSize(row.size)} · ${timeAgo(date)}` : humanSize(row.size);
  };
  const pickInput = (input: HTMLInputElement, prefix?: string) => {
    const files = filesFromInput(input);
    input.value = "";
    if (files.length === 0) return;
    void upload(
      prefix
        ? files.map((f, i) => ({ path: capturedName(f.file, prefix, i), file: f.file }))
        : files,
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drop zone; the Upload buttons are the keyboard path
    <div
      class="explorer"
      onDragEnter={(e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
        e.preventDefault();
        depth.current++;
        dragging.value = true;
      }}
      onDragOver={(e) => {
        if (dragging.value) e.preventDefault();
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) dragging.value = false;
      }}
      onDrop={onDrop}
    >
      <header class="topbar">
        <div class="brand">
          <IconCloud size={24} />
          <span>nubes</span>
        </div>
        <SyncBadge />
        <div class="topbar-actions">
          <button
            type="button"
            class="icon-btn"
            aria-label="Activity"
            title="Activity"
            onClick={() => open({ kind: "activity" })}
          >
            <IconActivity />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Recently deleted"
            title="Recently deleted"
            onClick={() => open({ kind: "trash" })}
          >
            <IconTrash />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Check for changes"
            onClick={() => refresh(true)}
          >
            <IconRefresh class={loading.value ? "spin" : ""} />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Settings"
            onClick={() => open({ kind: "settings" })}
          >
            <IconMore />
          </button>
        </div>
      </header>

      <main class="content">
        <div class="toolbar">
          {searching ? (
            <nav class="crumbs" aria-label="Folder">
              <span class="crumb">Search results</span>
            </nav>
          ) : (
            <Breadcrumbs />
          )}
          <div class="toolbar-actions">
            <button type="button" class="btn ghost" onClick={() => open({ kind: "newFolder" })}>
              <IconFolderPlus /> <span class="hide-sm">New folder</span>
            </button>
            <button type="button" class="btn ghost" onClick={() => open({ kind: "newNote" })}>
              <IconNote /> <span class="hide-sm">New note</span>
            </button>
            {canPickFolder() && (
              <button type="button" class="btn" onClick={() => folderInput.current?.click()}>
                <IconFolder /> <span class="hide-sm">Upload folder</span>
              </button>
            )}
            {touch && (
              <button type="button" class="btn" onClick={() => cameraInput.current?.click()}>
                <IconCamera /> <span class="hide-sm">Photo</span>
              </button>
            )}
            <button type="button" class="btn primary" onClick={() => filesInput.current?.click()}>
              <IconUpload /> Upload
            </button>
          </div>
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            onChange={(e) => pickInput(e.currentTarget)}
          />
          <input
            ref={(el) => {
              folderInput.current = el;
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            hidden
            onChange={(e) => pickInput(e.currentTarget)}
          />
          {touch && (
            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              aria-label="Take a photo"
              onChange={(e) => pickInput(e.currentTarget, "Photo")}
            />
          )}
        </div>

        <div class="listbar">
          <label class="visually-hidden" for="file-search">
            Search all files
          </label>
          <input
            id="file-search"
            type="search"
            class="search"
            placeholder="Search all files"
            value={query.value}
            spellcheck={false}
            autocapitalize="off"
            autocomplete="off"
            onInput={(e) => {
              query.value = e.currentTarget.value;
            }}
          />
          <label class="visually-hidden" for="sort-by">
            Sort by
          </label>
          <span class="select">
            <select
              id="sort-by"
              value={sortBy.value}
              onChange={(e) => setSortBy(e.currentTarget.value as SortBy)}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="date">Date</option>
            </select>
            <IconChevron size={16} class="select-chevron" />
          </span>
          <button
            type="button"
            class="icon-btn"
            aria-label={view.value === "grid" ? "Show as a list" : "Show as a grid"}
            title={view.value === "grid" ? "List" : "Grid"}
            onClick={() => setView(view.value === "grid" ? "list" : "grid")}
          >
            {view.value === "grid" ? <IconList /> : <IconGrid />}
          </button>
          <button
            type="button"
            class={`btn ghost${selecting.value ? " active" : ""}`}
            aria-pressed={selecting.value}
            onClick={() => {
              if (selecting.value) endSelection();
              else selecting.value = true;
            }}
          >
            <IconSelect /> <span class="hide-sm">{selecting.value ? "Done" : "Select"}</span>
          </button>
        </div>

        {locked.value && <Unlock />}
        {!searching && <FolderSync />}

        {!s ? (
          <div class="empty">
            <p class="muted">Loading…</p>
          </div>
        ) : rows.value.length === 0 ? (
          searching ? (
            <div class="empty">
              <p class="muted">No file matches “{query.value.trim()}”.</p>
            </div>
          ) : (
            <div class="empty drop-hint">
              <IconUpload size={36} />
              <p>
                <b>{cwd.value ? "This folder is empty" : "Nothing here yet"}</b>
              </p>
              <p class="muted">
                Drop files or folders anywhere on this page, paste an image, or use Upload.
              </p>
            </div>
          )
        ) : view.value === "grid" ? (
          <ul class="grid" aria-label="Files">
            {rows.value.map((row) => (
              <li key={row.path} class={`tile${sel.has(row.path) ? " selected" : ""}`}>
                <button
                  type="button"
                  class="tile-main"
                  aria-pressed={selecting.value ? sel.has(row.path) : undefined}
                  onClick={() => activate(row)}
                >
                  {row.kind === "file" && kindOf(row.name) === "image" ? (
                    <Thumb row={row} />
                  ) : (
                    <div class="thumb">
                      <FileIcon row={row} />
                    </div>
                  )}
                  <span class="tile-name">{row.name}</span>
                  {selecting.value && (
                    <span class="check-box" aria-hidden="true">
                      {sel.has(row.path) && <IconCheck size={16} />}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <ul class="files" aria-label="Files">
            {rows.value.map((row) => (
              <li key={row.path} class={`file-row${sel.has(row.path) ? " selected" : ""}`}>
                <button
                  type="button"
                  class="row-main"
                  aria-pressed={selecting.value ? sel.has(row.path) : undefined}
                  onClick={() => activate(row)}
                >
                  {selecting.value && (
                    <span class="check-box" aria-hidden="true">
                      {sel.has(row.path) && <IconCheck size={16} />}
                    </span>
                  )}
                  <FileIcon row={row} />
                  <span class="row-name">
                    {row.name}
                    {searching && dirname(row.path) && (
                      <span class="row-dir muted small">{dirname(row.path)}</span>
                    )}
                  </span>
                  {row.kind === "folder" && isPinned(pins.value, row.path) && (
                    <span class="tag" title="Its files open without a network">
                      offline
                    </span>
                  )}
                  <span class="row-meta">{meta(row)}</span>
                </button>
                {!selecting.value && (
                  <div class="row-more-wrap">
                    <button
                      type="button"
                      class="icon-btn row-more"
                      aria-label={`Actions for ${row.name}`}
                      aria-expanded={menu.value === row.path}
                      onClick={() => {
                        menu.value = menu.value === row.path ? null : row.path;
                      }}
                    >
                      <IconMore />
                    </button>
                    {menu.value === row.path && (
                      <RowMenu row={row} open={open} close={() => (menu.value = null)} />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {!searching && here && here.count > 0 && (
          <footer class="summary muted small">
            {here.count} file{here.count === 1 ? "" : "s"}{" "}
            {cwd.value ? "in this folder" : "in total"} · {humanSize(here.size)} ·{" "}
            <button type="button" class="link" onClick={() => downloadZip(cwd.value)}>
              download {cwd.value ? "this folder" : "everything"} as zip
            </button>
          </footer>
        )}
      </main>

      {selecting.value ? (
        <section class="selection-bar card" aria-label="Selection">
          <b>{sel.size === 0 ? "Tap items to select them" : `${sel.size} selected`}</b>
          <div class="row">
            <button
              type="button"
              class="btn small"
              disabled={sel.size === rows.value.length}
              onClick={() => (selected.value = new Set(rows.value.map((r) => r.path)))}
            >
              Select all
            </button>
            <button
              type="button"
              class="btn small"
              disabled={sel.size === 0}
              onClick={() => void downloadSelection([...sel], searching ? "" : cwd.value)}
            >
              <IconDownload size={16} /> Zip
            </button>
            <button
              type="button"
              class="btn small"
              disabled={sel.size === 0}
              onClick={() => open({ kind: "moveTo", paths: [...sel] })}
            >
              Move…
            </button>
            <button
              type="button"
              class="btn small danger"
              disabled={sel.size === 0}
              onClick={() => open({ kind: "deleteMany", paths: [...sel] })}
            >
              <IconTrash size={16} /> Delete
            </button>
          </div>
        </section>
      ) : (
        <UploadPanel />
      )}

      {dragging.value && (
        <div class="drop-overlay" aria-hidden="true">
          <div>
            <IconUpload size={40} />
            <p>Drop to upload to {cwd.value || "the top folder"}</p>
          </div>
        </div>
      )}

      {d?.kind === "preview" && (
        <Preview
          path={d.path}
          onClose={close}
          onHistory={() => open({ kind: "history", path: d.path })}
          onEdit={(text, sha) => open({ kind: "edit", path: d.path, baseSha: sha, initial: text })}
        />
      )}
      {d?.kind === "edit" && (
        <Editor path={d.path} baseSha={d.baseSha} initial={d.initial} onClose={close} />
      )}
      {d?.kind === "viewer" && <Viewer images={d.images} start={d.start} onClose={close} />}
      {d?.kind === "history" && <History path={d.path} onClose={close} />}
      {d?.kind === "activity" && <Activity onClose={close} />}
      {d?.kind === "trash" && <Trash onClose={close} />}
      {d?.kind === "rename" && <Rename path={d.path} onClose={close} />}
      {d?.kind === "moveTo" && (
        <MoveTo
          paths={d.paths}
          dir={cwd.value}
          onClose={() => {
            close();
            endSelection();
          }}
        />
      )}
      {d?.kind === "newFolder" && (
        <NewFolder
          dir={cwd.value}
          onClose={close}
          onCreate={(p) => {
            addDraftDir(p);
            cwd.value = p;
          }}
        />
      )}
      {d?.kind === "newNote" && (
        <NewNote
          dir={cwd.value}
          onClose={close}
          onCreate={(path) => open({ kind: "edit", path, baseSha: null, initial: "" })}
        />
      )}
      {d?.kind === "settings" && <Settings onClose={close} />}
      {d?.kind === "delete" && (
        <Confirm
          title={`Delete ${d.row.name}?`}
          body={
            d.row.kind === "folder"
              ? `The folder and its ${d.row.count} file${d.row.count === 1 ? "" : "s"} are removed from the repository (and from your synced devices at their next sync). They stay in “Recently deleted” and in the history.`
              : "The file is removed from the repository (and from your synced devices at their next sync). It stays in “Recently deleted” and in the history."
          }
          action="Delete"
          onConfirm={() => {
            if (d.row.count === 0 && d.row.kind === "folder") {
              const drafts = new Set(draftDirs.value);
              drafts.delete(d.row.path);
              draftDirs.value = drafts;
            } else void remove([d.row.path]);
          }}
          onClose={close}
        />
      )}
      {d?.kind === "deleteMany" && (
        <Confirm
          title={`Delete ${d.paths.length} item${d.paths.length === 1 ? "" : "s"}?`}
          body="They are removed from the repository in one change (and from your synced devices at their next sync). They stay in “Recently deleted” and in the history."
          action="Delete"
          onConfirm={() => {
            endSelection();
            void remove(d.paths);
          }}
          onClose={close}
        />
      )}
    </div>
  );
}
