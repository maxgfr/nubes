import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { zip } from "./zip";

test("zip round-trips", async () => {
  const enc = new TextEncoder();
  const blob = await zip([
    { name: "a.txt", read: async () => enc.encode("A") },
    { name: "dir/b.txt", read: async () => enc.encode("BB") },
  ]);
  const out = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  expect(Object.keys(out).sort()).toEqual(["a.txt", "dir/b.txt"]);
  expect(new TextDecoder().decode(out["dir/b.txt"])).toBe("BB");
});
