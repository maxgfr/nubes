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
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitBlobSha, loadEngineSync } from "../src/engine";
import { GitHub } from "../src/github/client";
import { Pool } from "../src/github/pool";
import { Remote } from "../src/github/repo";
import { createFakeGitHub, serveFakeGitHub } from "./fake-github";

setDefaultTimeout(30_000);
loadEngineSync(readFileSync(resolve(import.meta.dir, "../src/engine/pkg/nubes_engine_bg.wasm")));

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

/** Credentials (and encrypted folders' keys) of each test device, outside its synced folder. */
const credDirs = new Map<string, string>();

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "nubes-cli-"));
  const c = mkdtempSync(join(tmpdir(), "nubes-creds-"));
  dirs.push(d, c);
  credDirs.set(d, c);
  return d;
}

function env(cwd: string, device = "laptop", token = "test-token", extra = {}) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: cwd,
    NUBES_API_URL: api,
    NUBES_TOKEN: token,
    NUBES_DEVICE: device,
    NUBES_NO_GH: "1",
    NUBES_CREDENTIALS_FILE: join(credDirs.get(cwd) ?? cwd, "credentials"),
    ...extra,
  };
}

async function nubes(
  cwd: string,
  args: string[],
  device = "laptop",
  token = "test-token",
  extra: Record<string, string> = {},
): Promise<string> {
  const p = Bun.spawn([BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: env(cwd, device, token, extra),
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

  test("an encrypted folder: the CLI encrypts what the web app decrypts, and the reverse", async () => {
    const pass = { NUBES_PASSPHRASE: "correct horse battery staple" };
    const a = folder();
    write(a, "taxes/2026.pdf", "%PDF secret");
    await nubes(a, ["init", repo, "--encrypt"], "laptop", "test-token", pass);
    await nubes(a, ["sync"]); // the key is kept: no passphrase needed any more
    const stored = fake.files(repo);
    expect(stored["taxes/2026.pdf.age"]).toBeDefined();
    expect(stored["taxes/2026.pdf.age"]).not.toContain("secret");
    expect(stored["taxes/2026.pdf"]).toBeUndefined();
    expect(Object.keys(stored).some((p) => p.includes("credentials"))).toBe(false);

    // The web app opens it with the passphrase, reads, and writes.
    const gh = new GitHub("test-token", { api });
    const web = new Remote(gh, { full: repo, branch: "main", prefix: "" });
    const s = await web.state();
    expect([...s.files.keys()]).toEqual(["taxes/2026.pdf"]);
    await web.unlock(s, pass.NUBES_PASSPHRASE);
    const pdf = s.files.get("taxes/2026.pdf")?.sha as string;
    expect(new TextDecoder().decode(await web.get(pdf))).toBe("%PDF secret");
    await web.apply(async (now) => {
      const data = new TextEncoder().encode("written on the iPad");
      const sha = gitBlobSha(data);
      await web.put(data, sha, now);
      return [{ path: "ipad.txt", sha }];
    }, "nubes: 1 added (from ipad)");

    await nubes(a, ["sync"]);
    expect(read(a, "ipad.txt")).toBe("written on the iPad");

    // A second device needs the passphrase once; `lock` forgets the key.
    const b = folder();
    await expect(nubes(b, ["init", repo], "desk")).rejects.toThrow(/NUBES_PASSPHRASE/);
    await expect(
      nubes(b, ["init", repo], "desk", "test-token", { NUBES_PASSPHRASE: "wrong" }),
    ).rejects.toThrow(/wrong passphrase/);
    await nubes(b, ["init", repo], "desk", "test-token", pass);
    await nubes(b, ["sync"], "desk");
    expect(read(b, "taxes/2026.pdf")).toBe("%PDF secret");
    expect(await nubes(b, ["lock"], "desk")).toContain("key removed");
    await expect(nubes(b, ["sync"], "desk")).rejects.toThrow(/encrypted/);

    // A plain folder with files cannot be turned into an encrypted one.
    const c = folder();
    await expect(nubes(c, ["init", repo, "--encrypt"], "x", "test-token", pass)).rejects.toThrow(
      /already encrypted/,
    );
  });

  test("a file that would pass 100 MB once encrypted is skipped, and the rest syncs", async () => {
    const pass = { NUBES_PASSPHRASE: "correct horse battery staple" };
    const a = folder();
    write(a, "small.txt", "fits");
    // Under 100 MiB in clear, over it once sealed by age.
    write(a, "big.bin", "");
    truncateSync(join(a, "big.bin"), 100 * 1024 * 1024 - 1024);
    await nubes(a, ["init", repo, "--encrypt"], "laptop", "test-token", pass);
    const out = await nubes(a, ["sync"]);
    expect(out).toContain("big.bin: skipped, too large for GitHub");
    const stored = Object.keys(fake.files(repo));
    expect(stored).toContain("small.txt.age");
    expect(stored).not.toContain("big.bin.age");
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

  test("watch reacts to file events within seconds, and polls the branch with its ETag", async () => {
    const a = folder();
    write(a, "first.txt", "1");
    await nubes(a, ["init", repo]);
    const p = Bun.spawn([BIN, "watch", "--interval", "2"], {
      stdout: "ignore",
      stderr: "ignore",
      cwd: a,
      env: env(a),
    });
    const until = async (cond: () => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(100);
      }
    };
    try {
      await until(() => fake.files(repo)["first.txt"] === "1");
      // A local edit is pushed after the 2 s debounce, not at the next poll.
      const before = fake.stats.notModified;
      write(a, "notes/new.md", "# new");
      await until(() => fake.files(repo)["notes/new.md"] === "# new", 10_000);
      // A remote change comes down at the next poll.
      fake.push(repo, { "from-ipad.txt": "hi" });
      await until(() => existsSync(join(a, "from-ipad.txt")), 10_000);
      expect(read(a, "from-ipad.txt")).toBe("hi");
      // Unchanged polls were answered 304.
      await until(() => fake.stats.notModified > before, 10_000);
    } finally {
      p.kill();
      await p.exited;
    }
  });

  test("service install --print writes a launchd agent or a systemd unit running watch", async () => {
    const a = folder();
    await nubes(a, ["init", repo]);
    const out = await nubes(a, ["service", "install", "--print"]);
    if (process.platform === "darwin") {
      expect(out).toContain("<key>Label</key>");
      expect(out).toContain(`<string>${realpathSync(a)}</string>`);
      expect(out).toContain("<string>watch</string>");
    } else {
      expect(out).toContain(`-C "${realpathSync(a)}" watch`);
      expect(out).toContain("WantedBy=default.target");
    }
    expect(await nubes(a, ["service", "status"])).toContain("no service");
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

describe.skipIf(!has)("nubes CLI with a pool of repositories", () => {
  let name = "";
  beforeEach(() => {
    name = `pool${n}`;
  });
  const member = (i: number) => `octo/${name}-${i}`;
  const own = (files: Record<string, string>) =>
    Object.keys(files)
      .filter((p) => !p.startsWith(".nubes/"))
      .sort();

  test("init <name> creates the first private repository; another device joins it", async () => {
    const a = folder();
    write(a, "notes/todo.md", "milk");
    const out = await nubes(a, ["init", name]);
    expect(out).toContain(`created the private repository ${member(1)}`);
    expect(fake.hasRepo(member(1))).toBe(true);
    const meta = JSON.parse(fake.files(member(1))[".nubes/meta.json"] as string);
    expect(meta).toMatchObject({ format: "nubes", version: 3, pool: name, index: 1 });
    await nubes(a, ["sync"]);
    expect(own(fake.files(member(1)))).toEqual(["notes/todo.md"]);

    const b = folder();
    expect(await nubes(b, ["init", name], "ipad")).not.toContain("created the private");
    await nubes(b, ["sync"], "ipad");
    expect(read(b, "notes/todo.md")).toBe("milk");
    expect(fake.hasRepo(member(2))).toBe(false);
    expect(await nubes(b, ["status"], "ipad")).toContain(`${member(1)}: `);
  });

  test("a full repository spills new files into a new one; edits stay where they are", async () => {
    const a = folder();
    write(a, "old.txt", "v1");
    await nubes(a, ["init", name, "--max-size", "1G"]);
    await nubes(a, ["sync"]);
    fake.setSize(member(1), 2 * 1024 ** 3);

    write(a, "new.txt", "fresh");
    write(a, "old.txt", "v2");
    const out = await nubes(a, ["sync"]);
    expect(out).toContain(`created the private repository ${member(2)}`);
    expect(out).toContain(`in ${member(1)}`);
    expect(out).toContain(`in ${member(2)}`);
    expect(fake.files(member(1))["old.txt"]).toBe("v2");
    expect(fake.files(member(1))["new.txt"]).toBeUndefined();
    expect(fake.files(member(2))["new.txt"]).toBe("fresh");
    expect(JSON.parse(fake.files(member(2))[".nubes/meta.json"] as string).index).toBe(2);

    // Another device sees one folder.
    const b = folder();
    await nubes(b, ["init", name], "ipad");
    await nubes(b, ["sync"], "ipad");
    expect(read(b, "new.txt")).toBe("fresh");
    expect(read(b, "old.txt")).toBe("v2");
    expect(await nubes(b, ["ls"], "ipad")).toContain("2 file(s)");
    const status = await nubes(b, ["status"], "ipad");
    expect(status).toContain(`${member(1)}: 2.0 GB of 1.0 GB (full`);

    // Deleting a file deletes it in its own repository.
    rmSync(join(b, "new.txt"));
    await nubes(b, ["sync"], "ipad");
    expect(fake.files(member(2))["new.txt"]).toBeUndefined();
    await nubes(a, ["sync"]);
    expect(existsSync(join(a, "new.txt"))).toBe(false);

    // log and restore find the right repository.
    const log = await nubes(a, ["log", "old.txt"]);
    const first = log.trim().split("\n").at(-1)?.split(" ")[0] as string;
    await nubes(a, ["restore", "old.txt", "--at", first]);
    expect(read(a, "old.txt")).toBe("v1");
  });

  test("the same new path in two repositories: one keeps it, the other becomes a conflict copy", async () => {
    const a = folder();
    await nubes(a, ["init", name]);
    await nubes(a, ["sync"]);
    fake.addRepo(member(2));
    fake.push(member(2), { ".nubes/meta.json": JSON.stringify({ format: "nubes", pool: name }) });
    fake.push(member(1), { "x.txt": "from one", "same.txt": "S" });
    fake.push(member(2), { "x.txt": "from two", "same.txt": "S" });
    await nubes(a, ["sync"]);
    expect(read(a, "x.txt")).toBe("from one");
    const copy = readdirSync(a).find((f) => f.startsWith("x.conflict-")) as string;
    expect(copy).toBeDefined();
    expect(read(a, copy)).toBe("from two");
    expect(own(fake.files(member(1)))).toEqual(["same.txt", "x.txt"]);
    expect(own(fake.files(member(2)))).toEqual([copy]);
    expect(await nubes(a, ["sync"])).toContain("up to date");
  });

  test("an encrypted pool: one passphrase, the key follows into new repositories", async () => {
    const pass = { NUBES_PASSPHRASE: "correct horse battery staple" };
    const a = folder();
    write(a, "a.txt", "secret one");
    await nubes(a, ["init", name, "--encrypt"], "laptop", "test-token", pass);
    await nubes(a, ["sync"]);
    expect(fake.files(member(1))["a.txt.age"]).not.toContain("secret");
    fake.setSize(member(1), 6 * 1024 ** 3);
    write(a, "b.txt", "secret two");
    await nubes(a, ["sync"]);
    const two = fake.files(member(2));
    expect(two[".nubes/key.age"]).toBe(fake.files(member(1))[".nubes/key.age"] as string);
    expect(two["b.txt.age"]).toBeDefined();
    expect(two["b.txt.age"]).not.toContain("secret");

    const b = folder();
    await nubes(b, ["init", name], "desk", "test-token", pass);
    await nubes(b, ["sync"], "desk");
    expect(read(b, "a.txt")).toBe("secret one");
    expect(read(b, "b.txt")).toBe("secret two");
    expect(await nubes(b, ["lock"], "desk")).toContain("key removed");
    await expect(nubes(b, ["sync"], "desk")).rejects.toThrow(/encrypted/);
  });

  test("the web app reads and writes the same pool as the CLI", async () => {
    const a = folder();
    write(a, "cli.txt", "from the terminal");
    await nubes(a, ["init", name, "--max-size", "1G"]);
    await nubes(a, ["sync"]);
    fake.setSize(member(1), 2 * 1024 ** 3);

    const gh = new GitHub("test-token", { api });
    const web = new Pool(gh, { owner: "octo", name, maxSize: 1024 ** 3 });
    const s = await web.state();
    expect([...s.files.keys()]).toEqual(["cli.txt"]);
    await web.apply(async (now) => {
      const data = new TextEncoder().encode("from the browser");
      const sha = gitBlobSha(data);
      await web.put(data, sha, now, "web.txt");
      return [{ path: "web.txt", sha }];
    }, "nubes: 1 added (from ipad)");
    expect(fake.files(member(2))["web.txt"]).toBe("from the browser");

    await nubes(a, ["sync"]);
    expect(read(a, "web.txt")).toBe("from the browser");
    write(a, "web.txt", "edited in the terminal");
    await nubes(a, ["sync"]);
    expect(fake.files(member(2))["web.txt"]).toBe("edited in the terminal");
  });

  test("a token that cannot create repositories, and a name already taken, are refused", async () => {
    fake.tokens.add("no-admin");
    fake.noAdmin.add("no-admin");
    const a = folder();
    await expect(nubes(a, ["init", name], "laptop", "no-admin")).rejects.toThrow(/Administration/);
    expect(existsSync(join(a, ".nubes/config.json"))).toBe(false);

    fake.addRepo(member(1));
    fake.push(member(1), { "README.md": "someone else's" });
    await expect(nubes(a, ["init", name])).rejects.toThrow(/not part of the nubes pool/);
  });
});
