export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString();
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export type Kind = "image" | "pdf" | "text" | "video" | "audio" | "other";

const EXT: Record<string, Kind> = {};
for (const e of ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "heic"])
  EXT[e] = "image";
for (const e of ["mp4", "webm", "mov", "m4v"]) EXT[e] = "video";
for (const e of ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"]) EXT[e] = "audio";
EXT.pdf = "pdf";
for (const e of [
  "txt",
  "md",
  "markdown",
  "json",
  "csv",
  "tsv",
  "yml",
  "yaml",
  "toml",
  "xml",
  "html",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "rs",
  "py",
  "rb",
  "go",
  "java",
  "c",
  "h",
  "cpp",
  "sh",
  "zsh",
  "ini",
  "conf",
  "log",
  "env",
  "sql",
  "tex",
  "srt",
  "vtt",
  "org",
  "rst",
])
  EXT[e] = "text";

export function kindOf(path: string): Kind {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot < 0)
    return name.startsWith(".") || /^(readme|license|makefile|dockerfile)$/.test(name)
      ? "text"
      : "other";
  return EXT[name.slice(dot + 1)] ?? "other";
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  heic: "image/heic",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/opus",
};

export function mimeOf(path: string): string {
  const name = basename(path).toLowerCase();
  return MIME[name.slice(name.lastIndexOf(".") + 1)] ?? "application/octet-stream";
}
