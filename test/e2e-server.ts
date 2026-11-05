import { join, resolve } from "node:path";
import { serveApp } from "./serve";

const s = serveApp({
  port: Number(process.env.PORT ?? 4193),
  dir: join(resolve(import.meta.dir, ".."), "dist"),
});
console.log(`serving dist on ${s.port}`);
