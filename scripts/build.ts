/**
 * Production build: Bun.build on index.html, hashed assets, relative paths
 * only (the site lives under /nubes/), a CSP injected into the page, the
 * engine's WebAssembly copied as a hashed asset, and a generated service
 * worker that precaches all of it.
 *
 * The page may only talk to api.github.com. The build fails if the HTML has
 * an inline script or style, or a reference to an external origin.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const WASM = join(ROOT, "src/engine/pkg/nubes_engine_bg.wasm");

export const CSP = [
  "default-src 'none'",
  // The sync engine is WebAssembly; no eval of JavaScript.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self' https://api.github.com",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  // PDF previews.
  "frame-src blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

function headInject(): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    `<meta name="referrer" content="no-referrer" />`,
    `<meta name="color-scheme" content="light dark" />`,
    `<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="#15171b" media="(prefers-color-scheme: dark)" />`,
    `<meta name="description" content="Your files in a GitHub repository you own. Drag and drop from any device, sync a folder from the terminal. No server, no account beyond GitHub." />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-title" content="nubes" />`,
    `<link rel="manifest" href="./manifest.webmanifest" />`,
    `<link rel="icon" href="./icons/icon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />`,
  ].join("\n    ");
}

export interface BuildOptions {
  outdir?: string;
  minify?: boolean;
}

export interface BuildResult {
  outdir: string;
  version: string;
  files: string[];
}

function fail(msg: string): never {
  throw new Error(`build: ${msg}`);
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(p, base)));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out.sort();
}

function assertOk(result: Awaited<ReturnType<typeof Bun.build>>, what: string): void {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    fail(`${what} failed`);
  }
}

/** Throws if the HTML has an inline script, inline handler, inline style or external URL. */
export function auditHtml(html: string): void {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const body = (m[2] ?? "").trim();
    if (!/\bsrc\s*=/.test(attrs) || body.length > 0) fail("inline <script> found");
  }
  if (/\son[a-z]+\s*=/i.test(html)) fail("inline event handler found");
  if (/<style\b/i.test(html)) fail("inline <style> found");
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
    const url = m[1] ?? "";
    if (/^(?:[a-z]+:)?\/\//i.test(url)) fail(`external URL: ${url}`);
    if (url.startsWith("/")) fail(`absolute path (breaks the /nubes/ base): ${url}`);
  }
}

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const outdir = resolve(ROOT, opts.outdir ?? "dist");
  const minify = opts.minify ?? true;
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, "assets"), { recursive: true });

  // 1. The engine, as a hashed asset.
  const wasm = await readFile(WASM).catch(() =>
    fail("src/engine/pkg is missing: run `bun run engine` first"),
  );
  const wasmName = `assets/nubes_engine-${createHash("sha256").update(wasm).digest("hex").slice(0, 8)}.wasm`;
  await writeFile(join(outdir, wasmName), wasm);

  // 2. The app.
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { version: string };
  const app = await Bun.build({
    entrypoints: [join(ROOT, "index.html")],
    outdir,
    minify,
    splitting: true,
    target: "browser",
    format: "esm",
    naming: {
      entry: "[name].[ext]",
      chunk: "assets/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    define: {
      __ENGINE_WASM_URL__: JSON.stringify(`./${wasmName}`),
      __APP_VERSION__: JSON.stringify(pkg.version),
      "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development"),
    },
  });
  assertOk(app, "app build");

  // 3. Static files (manifest, icons).
  await cp(join(ROOT, "public"), outdir, { recursive: true });

  // 4. Harden the page.
  const page = join(outdir, "index.html");
  let html = await readFile(page, "utf8");
  if (!/<meta charset="utf-8"\s*\/?>/i.test(html))
    fail("index.html must start with <meta charset>");
  html = html.replace(/(<meta charset="utf-8"\s*\/?>)/i, `$1\n    ${headInject()}`);
  auditHtml(html);
  await writeFile(page, html);

  // 5. Service worker, versioned by the content hash of everything it caches.
  const files = (await listFiles(outdir)).filter((f) => f !== "sw.js");
  const hash = createHash("sha256");
  for (const f of files) {
    hash.update(f);
    hash.update(await readFile(join(outdir, f)));
  }
  const version = hash.digest("hex").slice(0, 16);
  const sw = await Bun.build({
    entrypoints: [join(ROOT, "src/sw.ts")],
    outdir,
    minify,
    target: "browser",
    format: "esm",
    naming: { entry: "sw.js" },
    define: {
      __SW_VERSION__: JSON.stringify(version),
      __PRECACHE__: JSON.stringify(["./", ...files.map((f) => `./${f}`)]),
    },
  });
  assertOk(sw, "service worker build");

  return { outdir, version, files: [...files, "sw.js"] };
}

if (import.meta.main) {
  const started = performance.now();
  const dev = process.argv.includes("--dev");
  const res = await build({ minify: !dev });
  let bytes = 0;
  for (const f of res.files) bytes += (await stat(join(res.outdir, f))).size;
  console.log(
    `built ${res.files.length} files (${(bytes / 1024).toFixed(1)} KiB) v${res.version} in ${Math.round(performance.now() - started)} ms`,
  );
}
