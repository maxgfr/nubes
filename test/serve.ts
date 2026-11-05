/** Static server for dist/ (dev loop and Playwright). */
import { join, normalize } from "node:path";

export function serveApp(opts: { port: number; dir: string }) {
  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(opts.dir, path));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      const headers: Record<string, string> = {};
      if (path.endsWith(".webmanifest")) headers["content-type"] = "application/manifest+json";
      if (path.endsWith(".wasm")) headers["content-type"] = "application/wasm";
      return new Response(file, { headers });
    },
  });
  return { port: server.port ?? opts.port, stop: () => server.stop(true) };
}
