import { expect, signIn, test } from "./fixtures";

test("sign in, pick a repository, upload, browse, preview", async ({ page, gh }) => {
  await signIn(page);
  await expect(page.getByText("Nothing here yet")).toBeVisible();

  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles([
    { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the iPad\n") },
    { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# notes\n") },
  ]);
  await expect(page.getByText("All uploads saved")).toBeVisible();
  expect(gh.files("octo/files")).toMatchObject({
    "hello.txt": "hello from the iPad\n",
    "notes.md": "# notes\n",
  });
  // One commit for the metadata, one for both files.
  expect(gh.commitCount("octo/files")).toBe(2);

  await page.getByRole("button", { name: /^hello\.txt/ }).click();
  await expect(page.locator(".preview pre")).toHaveText("hello from the iPad\n");
  await page.keyboard.press("Escape");

  // Re-uploading the same content commits nothing.
  await page
    .locator("input[type=file]:not([webkitdirectory])")
    .setInputFiles([
      { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("hello from the iPad\n") },
    ]);
  await expect(page.locator(".up-unchanged")).toBeVisible();
  expect(gh.commitCount("octo/files")).toBe(2);
});

test("changes from another device show up on their own", async ({ page, gh }) => {
  await page.clock.install();
  await signIn(page);
  gh.push("octo/files", { "from-mac/report.pdf": "%PDF-1.7" }, "nubes: 1 added (from mac)");
  await page.clock.runFor(31_000);
  await expect(page.getByRole("button", { name: /^from-mac/ })).toBeVisible();
  await page.getByRole("button", { name: /^from-mac/ }).click();
  await expect(page.getByRole("button", { name: /^report\.pdf/ })).toBeVisible();
});

test("folders, rename, delete, history and restore", async ({ page, gh }) => {
  gh.push("octo/files", { "docs/a.txt": "v1", "docs/b.txt": "B" }, "first");
  gh.push("octo/files", { "docs/a.txt": "v2" }, "second");
  await signIn(page);
  await page.getByRole("button", { name: /^docs/ }).click();
  await expect(page.getByRole("button", { name: /^a\.txt/ })).toBeVisible();

  // History of a.txt: restore v1.
  await page.getByRole("button", { name: "Actions for a.txt" }).click();
  await page.getByRole("menuitem", { name: "History" }).click();
  await expect(page.getByText("second")).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).first().click();
  await expect.poll(() => gh.files("octo/files")["docs/a.txt"]).toBe("v1");

  // Rename b.txt into a sub-folder.
  await page.getByRole("button", { name: "Actions for b.txt" }).click();
  await page.getByRole("menuitem", { name: "Rename or move" }).click();
  await page.getByLabel(/New path/).fill("docs/old/b.txt");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect
    .poll(() => Object.keys(gh.files("octo/files")).sort())
    .toEqual([".nubes/meta.json", "docs/a.txt", "docs/old/b.txt"]);

  // Delete the sub-folder.
  await page.getByRole("button", { name: "Actions for old" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect.poll(() => gh.files("octo/files")["docs/old/b.txt"]).toBeUndefined();
});

test("a new folder receives uploads; oversize and ignored files are refused", async ({
  page,
  gh,
}) => {
  await signIn(page);
  await page.getByRole("button", { name: /New folder/ }).click();
  await page.getByLabel("Name").fill("Scans 2026");
  await page.getByRole("button", { name: "Create" }).click();
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles([
    { name: "page1.jpg", mimeType: "image/jpeg", buffer: Buffer.from("jpg") },
    { name: ".DS_Store", mimeType: "application/octet-stream", buffer: Buffer.from("junk") },
  ]);
  await expect(page.getByText("Skipped: ignored")).toBeVisible();
  await expect.poll(() => gh.files("octo/files")["Scans 2026/page1.jpg"]).toBe("jpg");
  expect(gh.files("octo/files")["Scans 2026/.DS_Store"]).toBeUndefined();
});

test("the page refuses to talk to anything but GitHub (CSP)", async ({ page }) => {
  await page.goto("/?nosw");
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("connect-src 'self' https://api.github.com");
  expect(csp).not.toContain("unsafe-inline");
});

test("a bad token is refused with a clear message", async ({ page, gh }) => {
  void gh;
  await page.goto("/?nosw");
  await page.getByLabel("GitHub token").fill("wrong");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("refused the token");
});
