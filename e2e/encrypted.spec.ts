import { expect, test, useExisting } from "./fixtures";

const PASS = "correct horse battery staple";
const upload = "input[type=file]:not([webkitdirectory]):not([capture])";

test("an encrypted folder: GitHub stores ciphertext; another session needs the passphrase", async ({
  page,
  gh,
}) => {
  test.setTimeout(90_000);
  await page.goto("/?nosw");
  await page.getByLabel("GitHub token").fill("test-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel(/Encrypt the files end to end/).check();
  await page.getByLabel(/^Passphrase/).fill(PASS);
  await page.getByLabel("The passphrase again").fill("not the same one");
  await useExisting(page);
  await page.getByRole("button", { name: /octo\/files/ }).click();
  await expect(page.getByRole("alert")).toContainText("differ");
  await page.getByLabel("The passphrase again").fill(PASS);
  await page.getByRole("button", { name: /octo\/files/ }).click();
  await expect(page.getByText("Nothing here yet")).toBeVisible({ timeout: 30_000 });

  await page
    .locator(upload)
    .setInputFiles([
      { name: "diary.txt", mimeType: "text/plain", buffer: Buffer.from("dear diary") },
    ]);
  await expect(page.getByText("All uploads saved")).toBeVisible();
  const stored = gh.files("octo/files");
  expect(stored["diary.txt.age"]).toBeDefined();
  expect(stored["diary.txt.age"]).not.toContain("dear diary");
  expect(stored["diary.txt"]).toBeUndefined();
  await page.locator(".row-main", { hasText: "diary.txt" }).click();
  await expect(page.locator(".preview pre")).toHaveText("dear diary");
  await page.keyboard.press("Escape");

  // A new session: the names are listed, the contents wait for the passphrase.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByText("Encrypted end to end.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("GitHub token").fill("test-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This folder is encrypted end to end.")).toBeVisible();
  await expect(page.locator(".row-main", { hasText: "diary.txt" })).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong passphrase", { timeout: 30_000 });
  await page.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("This folder is encrypted end to end.")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.locator(".row-main", { hasText: "diary.txt" }).click();
  await expect(page.locator(".preview pre")).toHaveText("dear diary");
});
