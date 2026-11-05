import { describe, expect, test } from "bun:test";
import { createFakeGitHub } from "../../test/fake-github";
import { GitHub, GitHubError, RefMovedError, toBase64 } from "./client";
import { META_PATH, Remote } from "./repo";

function setup(prefix = "") {
  const fake = createFakeGitHub();
  fake.addRepo("octo/files");
  const gh = new GitHub("test-token", {
    api: "https://api.test",
    fetch: (input, init) => fake.handle(new Request(input, init)),
    sleep: async () => {},
  });
  const remote = new Remote(gh, { full: "octo/files", branch: "main", prefix });
  return { fake, gh, remote };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("Remote", () => {
  test("an empty repository has no head; ensureMeta creates the first commit", async () => {
    const { fake, remote } = setup();
    const s = await remote.state();
    expect(s.head).toBeNull();
    await remote.ensureMeta(s);
    const after = await remote.state();
    expect(after.head).not.toBeNull();
    expect(after.hasMeta).toBe(true);
    expect(Object.keys(fake.files("octo/files"))).toEqual([META_PATH]);
  });

  test("apply uploads and deletes in one commit", async () => {
    const { fake, gh, remote } = setup();
    const a = await remote.apply(async () => {
      const sha = await gh.createBlob("octo/files", bytes("A"));
      return [{ path: "docs/a.txt", sha }];
    }, "add a");
    expect(a).not.toBeNull();
    expect(fake.files("octo/files")["docs/a.txt"]).toBe("A");
    const before = fake.commitCount("octo/files");
    await remote.apply(() => [{ path: "docs/a.txt", sha: null }], "rm a");
    expect(fake.files("octo/files")["docs/a.txt"]).toBeUndefined();
    expect(fake.commitCount("octo/files")).toBe(before + 1);
  });

  test("a prefix keeps nubes inside a sub-folder", async () => {
    const { fake, gh, remote } = setup("cloud/");
    await remote.apply(async () => {
      const sha = await gh.createBlob("octo/files", bytes("x"));
      return [{ path: "x.txt", sha }];
    }, "add x");
    fake.push("octo/files", { "README.md": "outside" });
    expect(fake.files("octo/files")["cloud/x.txt"]).toBe("x");
    const s = await remote.state();
    expect([...s.files.keys()]).toEqual(["x.txt"]);
  });

  test("apply retries when the branch moves under it", async () => {
    const { fake, gh, remote } = setup();
    await remote.ensureMeta();
    let calls = 0;
    fake.beforeNextRefUpdate(() => fake.push("octo/files", { "other.txt": "meanwhile" }));
    await remote.apply(async () => {
      calls++;
      const sha = await gh.createBlob("octo/files", bytes("mine"));
      return [{ path: "mine.txt", sha }];
    }, "add mine");
    expect(calls).toBe(2);
    const files = fake.files("octo/files");
    expect(files["mine.txt"]).toBe("mine");
    expect(files["other.txt"]).toBe("meanwhile");
  });

  test("commit refuses a non fast-forward", async () => {
    const { fake, gh, remote } = setup();
    await remote.ensureMeta();
    const s = await remote.state();
    fake.push("octo/files", { "x.txt": "moved" });
    const sha = await gh.createBlob("octo/files", bytes("y"));
    await expect(
      remote.commit([{ path: "y.txt", sha }], "y", s.head as string, s.tree as string),
    ).rejects.toBeInstanceOf(RefMovedError);
  });

  test("history lists the commits that touched a path, and fileAt reads old versions", async () => {
    const { fake, gh } = setup();
    fake.push("octo/files", { "n.md": "v1" }, "v1");
    fake.push("octo/files", { other: "x" }, "other");
    fake.push("octo/files", { "n.md": "v2" }, "v2");
    const h = await gh.history("octo/files", "main", "n.md");
    expect(h.map((c) => c.message)).toEqual(["v2", "v1"]);
    const old = await gh.fileAt("octo/files", "n.md", h[1]?.sha as string);
    expect(new TextDecoder().decode(await gh.blob("octo/files", old as string))).toBe("v1");
  });

  test("bad tokens surface as a 401 GitHubError", async () => {
    const fake = createFakeGitHub();
    const gh = new GitHub("nope", {
      fetch: (input, init) => fake.handle(new Request(input, init)),
    });
    const e = await gh.user().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect((e as GitHubError).status).toBe(401);
  });

  test("rate limits are retried after retry-after", async () => {
    let n = 0;
    const waits: number[] = [];
    const gh = new GitHub("t", {
      fetch: async () => {
        n++;
        if (n === 1) return new Response("{}", { status: 403, headers: { "retry-after": "2" } });
        return Response.json({ login: "octo" });
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await gh.user()).toBe("octo");
    expect(waits).toEqual([2000]);
  });

  test("toBase64 handles large buffers", () => {
    const data = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(toBase64(data)).toBe(Buffer.from(data).toString("base64"));
  });
});
