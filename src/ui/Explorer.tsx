/** The file browser: breadcrumbs, folder listing, uploads, drag and drop. */
import { useComputed, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
  addDraftDir,
  busy,
  cwd,
  downloadFile,
  downloadZip,
  draftDirs,
  lastChecked,
  link,
  loading,
  online,
  refresh,
  remoteState,
  remove,
  startPolling,
  upload,
} from "../state";
import { canPickFolder, filesFromDrop, filesFromInput } from "./drop";
import { humanSize, kindOf } from "./format";
import {
  IconChevron,
  IconCloud,
  IconDownload,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconHistory,
  IconImage,
  IconMore,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconUpload,
} from "./icons";
import { listDir, type Row, totals } from "./listing";
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
        : lastChecked.value
          ? "Up to date"
          : "Connecting…";
  const tone = !online.value ? "warn" : busy.value || loading.value ? "busy" : "ok";
  return (
    <span
      class={`badge badge-${tone}`}
      title={lastChecked.value ? `Checked ${new Date(lastChecked.value).toLocaleTimeString()}` : ""}
    >
      <span class="dot" />
      {label}
    </span>
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
        <button type="button" role="menuitem" onClick={act(() => void downloadZip(row.path))}>
          <IconDownload size={18} /> Download as zip
        </button>
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

export function Explorer() {
  const dialog = useSignal<Dialog | null>(null);
  const menu = useSignal<string | null>(null);
  const dragging = useSignal(false);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  useEffect(() => startPolling(), []);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".row-more, .menu")) menu.value = null;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
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

  const rows = useComputed(() => {
    const s = remoteState.value;
    return s ? listDir(s.files, cwd.value, draftDirs.value) : [];
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
          <Breadcrumbs />
          <div class="toolbar-actions">
            <button type="button" class="btn ghost" onClick={() => open({ kind: "newFolder" })}>
              <IconFolderPlus /> <span class="hide-sm">New folder</span>
            </button>
            {canPickFolder() && (
              <button type="button" class="btn" onClick={() => folderInput.current?.click()}>
                <IconFolder /> <span class="hide-sm">Upload folder</span>
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
            onChange={(e) => {
              const files = filesFromInput(e.currentTarget);
              e.currentTarget.value = "";
              if (files.length) void upload(files);
            }}
          />
          <input
            ref={(el) => {
              folderInput.current = el;
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = filesFromInput(e.currentTarget);
              e.currentTarget.value = "";
              if (files.length) void upload(files);
            }}
          />
        </div>

        <FolderSync />

        {!s ? (
          <div class="empty">
            <p class="muted">Loading…</p>
          </div>
        ) : rows.value.length === 0 ? (
          <div class="empty drop-hint">
            <IconUpload size={36} />
            <p>
              <b>{cwd.value ? "This folder is empty" : "Nothing here yet"}</b>
            </p>
            <p class="muted">Drop files or folders anywhere on this page, or use Upload.</p>
          </div>
        ) : (
          <ul class="files" aria-label="Files">
            {rows.value.map((row) => (
              <li key={row.path} class="file-row">
                <button
                  type="button"
                  class="row-main"
                  onClick={() => {
                    if (row.kind === "folder") cwd.value = row.path;
                    else open({ kind: "preview", path: row.path });
                  }}
                >
                  <FileIcon row={row} />
                  <span class="row-name">{row.name}</span>
                  <span class="row-meta">
                    {row.kind === "folder"
                      ? row.count === 0
                        ? "empty"
                        : `${row.count} file${row.count === 1 ? "" : "s"} · ${humanSize(row.size)}`
                      : humanSize(row.size)}
                  </span>
                </button>
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
              </li>
            ))}
          </ul>
        )}

        {here && here.count > 0 && (
          <footer class="summary muted small">
            {here.count} file{here.count === 1 ? "" : "s"}{" "}
            {cwd.value ? "in this folder" : "in total"} · {humanSize(here.size)} ·{" "}
            <button type="button" class="link" onClick={() => downloadZip(cwd.value)}>
              download {cwd.value ? "this folder" : "everything"} as zip
            </button>
          </footer>
        )}
      </main>

      <UploadPanel />

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
        />
      )}
      {d?.kind === "history" && <History path={d.path} onClose={close} />}
      {d?.kind === "rename" && <Rename path={d.path} onClose={close} />}
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
      {d?.kind === "settings" && <Settings onClose={close} />}
      {d?.kind === "delete" && (
        <Confirm
          title={`Delete ${d.row.name}?`}
          body={
            d.row.kind === "folder"
              ? `The folder and its ${d.row.count} file${d.row.count === 1 ? "" : "s"} are removed from the repository (and from your synced devices at their next sync). Earlier versions stay in the history.`
              : "The file is removed from the repository (and from your synced devices at their next sync). Earlier versions stay in the history."
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
    </div>
  );
}
