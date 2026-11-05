/**
 * Bundle budget: the JavaScript needed for the first screen (the entry
 * script and everything it imports statically) must stay under 40 KB gzip.
 * Lazily loaded chunks (zip) and the engine (WebAssembly) are reported
 * but not counted.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGET_GZIP = 40 * 1024;
const DIST = resolve(import.meta.dir, "../dist");

const gz = (file: string) => gzipSync(readFileSync(file), { level: 9 }).length;

/** The entry script plus its static import closure. */
export function initialScripts(dist: string): string[] {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const entries = [...html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)].map((m) =>
    join(dist, m[1] as string),
  );
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Static imports only: `import ... from "./x.js"` and `import "./x.js"`, not `import("./x.js")`.
    for (const m of src.matchAll(
      /(?:^|[;\s}])import\s*(?:[^"'()]*?\bfrom\s*)?["'](\.\/[^"']+\.js)["']/g,
    )) {
      visit(join(dirname(file), m[1] as string));
    }
  };
  for (const e of entries) visit(e);
  return [...seen];
}

if (import.meta.main) {
  const initial = initialScripts(DIST);
  let total = 0;
  for (const f of initial) total += gz(f);
  const assets = join(DIST, "assets");
  const files = readdirSync(assets, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(assets, join(e.parentPath, e.name)))
    .sort();
  for (const f of files) {
    const p = join(assets, f);
    const tag = initial.includes(p) ? "initial" : f.endsWith(".js") ? "lazy" : "asset";
    console.log(`${tag.padEnd(8)} ${(gz(p) / 1024).toFixed(1).padStart(6)} KB gz  ${f}`);
  }
  console.log(`initial JS: ${(total / 1024).toFixed(1)} KB gzip (budget ${BUDGET_GZIP / 1024} KB)`);
  if (total > BUDGET_GZIP) {
    console.error("over budget");
    process.exit(1);
  }
}
