import { expect, test } from "bun:test";
import { filterRepos } from "./Onboarding";

test("repository search matches every word, case-insensitively", () => {
  const repos = [
    { fullName: "maxgfr/nubes-files" },
    { fullName: "maxgfr/obscura" },
    { fullName: "acme/Files" },
  ];
  expect(filterRepos(repos, "  ")).toHaveLength(3);
  expect(filterRepos(repos, "FILES").map((r) => r.fullName)).toEqual([
    "maxgfr/nubes-files",
    "acme/Files",
  ]);
  expect(filterRepos(repos, "max files").map((r) => r.fullName)).toEqual(["maxgfr/nubes-files"]);
  expect(filterRepos(repos, "zzz")).toEqual([]);
});
