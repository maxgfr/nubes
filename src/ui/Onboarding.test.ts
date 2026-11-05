import { expect, test } from "bun:test";
import { filterRepos, isPublicOnly } from "./Onboarding";

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

test("a token that lists only public repositories is flagged", () => {
  expect(isPublicOnly(null)).toBe(false);
  expect(isPublicOnly([])).toBe(false);
  expect(isPublicOnly([{ private: false }, { private: false }])).toBe(true);
  expect(isPublicOnly([{ private: false }, { private: true }])).toBe(false);
});
