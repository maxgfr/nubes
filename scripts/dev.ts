/** Dev loop: rebuilds dist/ (unminified) on every change and serves it. */
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { serveApp } from "../test/serve";
import { build } from "./build";

const ROOT = resolve(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 5173);

async function rebuild(): Promise<void> {
  try {
    const res = await build({ minify: false });
    console.log(`rebuilt v${res.version}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

await rebuild();
const server = serveApp({ port, dir: join(ROOT, "dist") });
console.log(`nubes dev server on http://localhost:${server.port}/?nosw`);

let timer: ReturnType<typeof setTimeout> | undefined;
for (const target of ["src", "index.html", "public"]) {
  watch(join(ROOT, target), { recursive: true }, (_e, file) => {
    if (String(file ?? "").includes("engine/pkg")) return;
    clearTimeout(timer);
    timer = setTimeout(rebuild, 80);
  });
}
