/**
 * The CLI against the fake GitHub, end to end: real binary, real folders.
 * Also checks interop with the web app's client (what one writes, the other reads).
 * Needs `cargo build -p nubes-cli` first; skipped otherwise.
 */
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitHub } from "../src/github/client";
import { Remote } from "../src/github/repo";
import { createFakeGitHub, serveFakeGitHub } from "./fake-github";

setDefaultTimeout(30_000);

const BIN = resolve(import.meta.dir, "../target/debug/nubes");
const has = existsSync(BIN);

const fake = createFakeGitHub();
const server = serveFakeGitHub(fake);
const api = `http://localhost:${server.port}`;
const dirs: string[] = [];
afterAll(() => {
  server.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "nubes-cli-"));
  dirs.push(d);
  return d;
}

async function nubes(
  cwd: string,
  args: string[],
  device = "laptop",
  token = "test-token",
): Promise<string> {
  const p = Bun.spawn([BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      NUBES_API_URL: api,
      NUBES_TOKEN: token,
      NUBES_DEVICE: device,
      NUBES_NO_GH: "1",
      NUBES_CREDENTIALS_FILE: join(cwd, ".creds"),
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const out = stdout + stderr;
  if (code !== 0) throw new Error(`nubes ${args.join(" ")} failed:\n${out}`);
  return out;
}

const read = (d: string, p: string) => readFileSync(join(d, p), "utf8");
function write(d: string, p: string, text: string) {
  mkdirSync(join(d, p, ".."), { recursive: true });
  writeFileSync(join(d, p), text);
}

let repo = "";
let n = 0;
beforeEach(() => {
  repo = `octo/files${++n}`;
  fake.addRepo(repo);
});

describe.skipIf(!has)("nubes CLI", () => {
  test("selftest and skill", async () => {
    const d = folder();
    expect(await nubes(d, ["selftest"])).toContain("selftest ok");
    expect(await nubes(d, ["skill"])).toContain("name: nubes");
  });

  test("init refuses a token that can read the repository but not write to it", async () => {
    fake.tokens.add("read-only");
    fake.readOnly.add("read-only");
    fake.push(repo, { "a.txt": "A" });
    const d = folder();
    await expect(nubes(d, ["init", repo], "laptop", "read-only")).rejects.toThrow(
      /can read .* but not write/,
    );
    expect(existsSync(join(d, ".nubes/config.json"))).toBe(false);
    await nubes(d, ["init", repo]);
    expect(existsSync(join(d, ".nubes/config.json"))).toBe(true);
  });

  test("init + sync uploads a folder in one commit; a second device gets it", async () => {
    const a = folder();
    write(a, "docs/report.txt", "v1");
    write(a, "photo.jpg", "jpeg");
    write(a, ".DS_Store", "junk");
    await nubes(a, ["init", repo]);
    expect(await nubes(a, ["status"])).toContain("would upload 2");
    await nubes(a, ["sync"]);
    expect(fake.files(repo)).toMatchObject({ "docs/report.txt": "v1", "photo.jpg": "jpeg" });
    expect(fake.files(repo)[".DS_Store"]).toBeUndefined();
    // meta commit + sync commit
    expect(fake.commitCount(repo)).toBe(2);
    expect(await nubes(a, ["sync"])).toContain("up to date");

    const b = folder();
    await nubes(b, ["init", repo], "ipad");
    await nubes(b, ["sync"], "ipad");
    expect(read(b, "docs/report.txt")).toBe("v1");
    expect(existsSync(join(b, ".nubes/state.json"))).toBe(true);
  });

  test("edits, deletions and conflicts between two devices", async () => {
    const a = folder();
    const b = folder();
    write(a, "notes.md", "base");
    write(a, "old.txt", "old");
    await nubes(a, ["init", repo]);
    await nubes(a, ["sync"]);
    await nubes(b, ["init", repo], "desk");
    await nubes(b, ["sync"], "desk");

    // A deletes old.txt and edits notes.md; B edits notes.md too.
    rmSync(join(a, "old.txt"));
    write(a, "notes.md", "from a");
    await nubes(a, ["sync"]);
    write(b, "notes.md", "from b!");
    const out = await nubes(b, ["sync"], "desk");
    expect(out).toContain("changed on both sides");

    expect(existsSync(join(b, "old.txt"))).toBe(false);
    expect(read(b, "notes.md")).toBe("from a");
    const copy = readdirSync(b).find((f) => f.startsWith("notes.conflict-desk-"));
    expect(copy).toBeDefined();
    expect(read(b, copy as string)).toBe("from b!");

    // A gets the conflict copy back on its next sync.
    await nubes(a, ["sync"]);
    expect(read(a, copy as string)).toBe("from b!");
    expect(fake.files(repo)["old.txt"]).toBeUndefined();
  });

  test("the web client's uploads reach the CLI, and the CLI's reach the web client", async () => {
    const gh = new GitHub("test-token", { api });
    const remote = new Remote(gh, { full: repo, branch: "main", prefix: "" });
    await remote.apply(async () => {
      const sha = await gh.createBlob(repo, new TextEncoder().encode("dropped on the iPad"));
      return [{ path: "inbox/scan.txt", sha }];
    }, "nubes: 1 added (from web)");

    const a = folder();
    await nubes(a, ["init", repo]);
    await nubes(a, ["sync"]);
    expect(read(a, "inbox/scan.txt")).toBe("dropped on the iPad");

    write(a, "inbox/reply.txt", "from the mac");
    await nubes(a, ["sync"]);
    const s = await remote.state();
    expect([...s.files.keys()].sort()).toEqual(["inbox/reply.txt", "inbox/scan.txt"]);
  });

  test("push and pull go one way; restore brings back an old version", async () => {
    const a = folder();
    write(a, "x.txt", "1");
    await nubes(a, ["init", repo]);
    await nubes(a, ["push"]);
    fake.push(repo, { "y.txt": "remote" });
    write(a, "x.txt", "2");
    await nubes(a, ["push"]);
    expect(existsSync(join(a, "y.txt"))).toBe(false);
    expect(fake.files(repo)["x.txt"]).toBe("2");
    await nubes(a, ["pull"]);
    expect(read(a, "y.txt")).toBe("remote");

    const log = await nubes(a, ["log", "x.txt"]);
    const first = log.trim().split("\n").at(-1)?.split(" ")[0] as string;
    await nubes(a, ["restore", "x.txt", "--at", first]);
    expect(read(a, "x.txt")).toBe("1");
    expect(await nubes(a, ["ls"])).toContain("2 file(s)");
  });

  test("a prefix syncs only a sub-folder of the repository", async () => {
    fake.push(repo, { "README.md": "not synced" });
    const a = folder();
    write(a, "a.txt", "A");
    await nubes(a, ["init", `${repo}:cloud/docs`]);
    await nubes(a, ["sync"]);
    expect(fake.files(repo)["cloud/docs/a.txt"]).toBe("A");
    expect(existsSync(join(a, "README.md"))).toBe(false);
  });

  test(".nubesignore keeps files local", async () => {
    const a = folder();
    write(a, ".nubesignore", "*.tmp\nbuild/\n");
    write(a, "a.tmp", "x");
    write(a, "build/out.bin", "x");
    write(a, "keep.txt", "x");
    await nubes(a, ["init", repo]);
    await nubes(a, ["sync"]);
    expect(Object.keys(fake.files(repo)).sort()).toEqual([
      ".nubes/meta.json",
      ".nubesignore",
      "keep.txt",
    ]);
  });
});
