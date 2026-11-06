import { expect, test } from "./fixtures";

const upload = "input[type=file]:not([webkitdirectory]):not([capture])";
const file = (name: string, text: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from(text),
});

test("a name creates its first private repository; a full one spills into the next", async ({
  page,
  gh,
}) => {
  await page.goto("/?nosw");
  await page.getByLabel("GitHub token").fill("test-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Name your folder" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("vault");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByText("Nothing here yet")).toBeVisible();
  expect(gh.hasRepo("octo/vault-1")).toBe(true);

  await page.locator(upload).setInputFiles([file("notes.txt", "first")]);
  await expect(page.getByText("All uploads saved")).toBeVisible();
  expect(gh.files("octo/vault-1")["notes.txt"]).toBe("first");

  // vault-1 is full: the next new file goes to a new repository, edits stay.
  gh.setSize("octo/vault-1", 6 * 1024 ** 3);
  await page.locator(upload).setInputFiles([file("later.txt", "second")]);
  await expect(page.getByText("All uploads saved")).toBeVisible();
  expect(gh.files("octo/vault-2")["later.txt"]).toBe("second");
  expect(gh.files("octo/vault-1")["later.txt"]).toBeUndefined();
  await page.locator(upload).setInputFiles([file("notes.txt", "edited")]);
  await expect(page.getByText("All uploads saved")).toBeVisible();
  expect(gh.files("octo/vault-1")["notes.txt"]).toBe("edited");
  expect(gh.files("octo/vault-2")["notes.txt"]).toBeUndefined();

  // One folder, two repositories in the storage panel.
  await expect(page.locator(".row-main", { hasText: "later.txt" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".storage-member")).toHaveCount(2);
  await expect(page.locator(".storage-member").first()).toContainText("full");
});

test("another device opens the same name; a token that cannot create repositories is told why", async ({
  page,
  gh,
}) => {
  gh.addRepo("octo/photos-1");
  gh.push("octo/photos-1", {
    ".nubes/meta.json": JSON.stringify({ format: "nubes", version: 3, pool: "photos", index: 1 }),
    "beach.txt": "sand",
  });
  gh.tokens.add("no-admin");
  gh.noAdmin.add("no-admin");
  await page.goto("/?nosw");
  await page.getByLabel("GitHub token").fill("no-admin");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("brand-new");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toContainText("Administration");

  // Existing repositories need no creation.
  await page.getByLabel("Name", { exact: true }).fill("photos");
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".row-main", { hasText: "beach.txt" })).toBeVisible();
});
