import { expect, signIn, test } from "./fixtures";

const upload = "input[type=file]:not([webkitdirectory]):not([capture])";

test("search the whole repository; sort by size or by date", async ({ page, gh }) => {
  gh.push("octo/files", { "docs/old-report.txt": "x".repeat(10), "big.bin": "y".repeat(500) });
  gh.push("octo/files", { "work/2026/report-final.md": "z" });
  await signIn(page);

  await page.getByLabel("Search all files").fill("REPORT");
  await expect(page.locator(".row-name")).toHaveCount(2);
  await expect(page.locator(".row-main", { hasText: "report-final.md" })).toContainText(
    "work/2026",
  );
  await page.getByLabel("Search all files").fill("nothing");
  await expect(page.getByText("No file matches")).toBeVisible();
  await page.getByLabel("Search all files").fill("");

  await page.getByLabel("Sort by").selectOption("size");
  await expect(page.locator(".row-name")).toHaveText(["docs", "work", "big.bin"]);
  // By date: the latest change first (work/ was pushed last).
  await page.getByLabel("Sort by").selectOption("date");
  await expect(page.locator(".row-name")).toHaveText(["work", "docs", "big.bin"]);
  await expect(page.locator(".row-main", { hasText: "big.bin" })).toContainText("just now");
});

test("select several items to move, zip or delete them in one commit", async ({ page, gh }) => {
  gh.push("octo/files", {
    ".nubes/meta.json": "{}",
    "a.txt": "A",
    "b.txt": "B",
    "c.txt": "C",
    "keep/k.txt": "K",
  });
  await signIn(page);
  const commits = gh.commitCount("octo/files");

  await page.getByRole("button", { name: "Select" }).click();
  await page.locator(".row-main", { hasText: "a.txt" }).click();
  await page.locator(".row-main", { hasText: "b.txt" }).click();
  await expect(page.getByText("2 selected")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Zip", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("files.zip");

  await page.getByRole("button", { name: "Move…" }).click();
  await page.getByLabel(/To the folder/).fill("archive");
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect
    .poll(() => Object.keys(gh.files("octo/files")).sort())
    .toEqual([".nubes/meta.json", "archive/a.txt", "archive/b.txt", "c.txt", "keep/k.txt"]);
  expect(gh.commitCount("octo/files")).toBe(commits + 1);

  await page.getByRole("button", { name: "Select" }).click();
  await page.locator(".row-main", { hasText: "c.txt" }).click();
  await page.locator(".row-main", { hasText: "keep" }).click();
  await page.locator(".selection-bar").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(() => Object.keys(gh.files("octo/files")).sort())
    .toEqual([".nubes/meta.json", "archive/a.txt", "archive/b.txt"]);
  expect(gh.commitCount("octo/files")).toBe(commits + 2);
});

test("recently deleted files come back in one click, without uploading them again", async ({
  page,
  gh,
}) => {
  gh.push("octo/files", { "notes/todo.md": "- milk", "notes/keep.md": "k" });
  gh.push("octo/files", { "notes/todo.md": null }, "nubes: 1 deleted (from mac)");
  await signIn(page);
  await page.getByRole("button", { name: "Recently deleted" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("notes/todo.md")).toBeVisible();
  const posts = gh.log.filter((l) => l.startsWith("POST") && l.endsWith("/git/blobs")).length;
  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => gh.files("octo/files")["notes/todo.md"]).toBe("- milk");
  expect(gh.log.filter((l) => l.startsWith("POST") && l.endsWith("/git/blobs")).length).toBe(posts);
  await expect(dialog.getByText("Nothing deleted recently.")).toBeVisible();
});

test("edit a note; a change made elsewhere meanwhile becomes a conflict copy", async ({
  page,
  gh,
}) => {
  gh.push("octo/files", { "notes/list.md": "one\n" });
  await signIn(page);
  await page.locator(".row-main", { hasText: "notes" }).click();
  await page.locator(".row-main", { hasText: "list.md" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Content of list.md").fill("one\ntwo\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => gh.files("octo/files")["notes/list.md"]).toBe("one\ntwo\n");

  // Edit again, but another device saves first.
  await page.locator(".row-main", { hasText: "list.md" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Content of list.md").fill("mine\n");
  gh.push("octo/files", { "notes/list.md": "theirs\n" }, "nubes: 1 updated (from mac)");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/changed elsewhere meanwhile/)).toBeVisible();
  const files = gh.files("octo/files");
  expect(files["notes/list.md"]).toBe("theirs\n");
  const copy = Object.keys(files).find((p) => p.startsWith("notes/list.conflict-"));
  expect(copy).toMatch(/^notes\/list\.conflict-[\w-]+-\d{8}-\d{4}\.md$/);
  expect(files[copy as string]).toBe("mine\n");

  // A new note.
  await page.getByRole("button", { name: /New note/ }).click();
  await page.getByLabel("Name").fill("ideas.md");
  await page.getByRole("button", { name: "Write" }).click();
  await page.getByLabel("Content of ideas.md").fill("# Ideas\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(() => gh.files("octo/files")["notes/ideas.md"]).toBe("# Ideas\n");
});

test("photos in a grid, then full screen from one to the next", async ({ page, gh }) => {
  gh.push("octo/files", { "trip/1.jpg": "jpeg-1", "trip/2.jpg": "jpeg-2", "trip/notes.txt": "n" });
  await signIn(page);
  await page.locator(".row-main", { hasText: "trip" }).click();
  await page.getByRole("button", { name: "Show as a grid" }).click();
  await expect(page.locator(".tile")).toHaveCount(3);
  await page.locator(".tile-main", { hasText: "1.jpg" }).click();
  const viewer = page.getByRole("dialog", { name: "1.jpg" });
  await expect(viewer.getByText("1 / 2")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("dialog", { name: "2.jpg" }).getByText("2 / 2")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("dialog", { name: "1.jpg" })).toBeVisible();
  await page.keyboard.press("Escape");
  // The choice is remembered.
  await page.reload();
  await expect(page.locator(".grid")).toBeVisible();
});

test("a pasted image is uploaded to the current folder; touch screens get a camera button", async ({
  page,
  gh,
  isMobile,
}) => {
  gh.push("octo/files", { "scans/old.txt": "o" });
  await signIn(page);
  await page.locator(".row-main", { hasText: "scans" }).click();
  await expect(page.getByRole("button", { name: /Photo/ })).toHaveCount(isMobile ? 1 : 0);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }));
    const e = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "clipboardData", { value: dt });
    document.body.dispatchEvent(e);
  });
  await expect
    .poll(() => Object.keys(gh.files("octo/files")).find((p) => p.startsWith("scans/Pasted ")))
    .toMatch(/^scans\/Pasted \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
});

test("activity shows what changed, by device; settings show the storage used", async ({
  page,
  gh,
}) => {
  gh.push("octo/files", { "docs/a.txt": "1" }, "nubes: 1 added (from ipad)");
  gh.push("octo/files", { "docs/b.txt": "2" }, "nubes: 1 added (from mac)");
  gh.push("octo/files", { "docs/a.txt": "3" }, "nubes: 1 updated (from mac)");
  await signIn(page);
  await page
    .locator(upload)
    .setInputFiles([{ name: "c.txt", mimeType: "text/plain", buffer: Buffer.from("c") }]);
  await expect(page.getByText("All uploads saved")).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  const dialog = page.getByRole("dialog", { name: "Activity" });
  await expect(dialog.locator(".activity-main")).toHaveCount(5);
  await dialog.getByRole("button", { name: "mac", exact: true }).click();
  await expect(dialog.locator(".activity-main")).toHaveCount(2);
  await dialog.locator(".activity-main", { hasText: "1 updated" }).click();
  await expect(dialog.locator(".activity-files")).toContainText("a.txt");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".storage")).toContainText("of 5 GB recommended");
});
