import type { Page, Route } from "@playwright/test";
import { expect, signIn, test } from "./fixtures";

/**
 * A network outage: GitHub unreachable, and the browser says so, even
 * after a reload. (Not context.setOffline: WebKit's emulation also blocks
 * reading local files.)
 */
const cut = (route: Route) => route.abort("internetdisconnected");
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => sessionStorage.getItem("test-offline") !== "1",
    });
  });
});
async function goOffline(page: Page) {
  await page.route("https://api.github.com/**", cut);
  await page.evaluate(() => {
    sessionStorage.setItem("test-offline", "1");
    window.dispatchEvent(new Event("offline"));
  });
}
async function goOnline(page: Page) {
  await page.unroute("https://api.github.com/**", cut);
  await page.evaluate(() => {
    sessionStorage.removeItem("test-offline");
    window.dispatchEvent(new Event("online"));
  });
}

test("files added offline wait on the device and are sent when the network is back", async ({
  page,
  gh,
}) => {
  gh.push("octo/files", { "notes/a.txt": "A" });
  await signIn(page);
  await goOffline(page);
  await page
    .locator("input[type=file]:not([webkitdirectory]):not([capture])")
    .setInputFiles([
      { name: "offline.txt", mimeType: "text/plain", buffer: Buffer.from("written on a plane") },
    ]);
  await expect(page.getByText("1 waiting to upload")).toBeVisible();
  await expect(page.getByText(/will be sent when back online/)).toBeVisible();
  expect(gh.files("octo/files")["offline.txt"]).toBeUndefined();

  await goOnline(page);
  await expect.poll(() => gh.files("octo/files")["offline.txt"]).toBe("written on a plane");
  await expect(page.getByText("1 waiting to upload")).toHaveCount(0);
  await expect(page.getByText("All uploads saved")).toBeVisible();
});

test("a folder kept offline is stored on the device and opens without a network", async ({
  page,
  gh,
  browserName,
}) => {
  gh.push("octo/files", { "docs/a.txt": "kept", "other/b.txt": "not kept" });
  await signIn(page);
  await page.getByRole("button", { name: "Actions for docs" }).click();
  await page.getByRole("menuitem", { name: "Keep offline" }).click();
  await expect(page.locator(".file-row", { hasText: "docs" }).locator(".tag")).toHaveText(
    "offline",
  );
  const cached = () =>
    page.evaluate(async () => {
      const c = await caches.open("nubes-pins:octo/files#main#");
      return Promise.all((await c.keys()).map(async (k) => (await c.match(k))?.text() ?? ""));
    });
  await expect.poll(cached).toEqual(["kept"]);

  // A fresh start without GitHub: the last tree seen, the kept file from the cache.
  // (Playwright's WebKit sessions are ephemeral and empty Cache Storage on reload;
  // Safari keeps it, so WebKit checks the offline preview without the reload.)
  await goOffline(page);
  if (browserName !== "webkit") await page.reload();
  await expect(page.getByText("Offline", { exact: true })).toBeVisible();
  await page.locator(".row-main", { hasText: "docs" }).click();
  await page.getByRole("button", { name: /^a\.txt/ }).click();
  await expect(page.locator(".preview pre")).toHaveText("kept");
  await page.keyboard.press("Escape");
  await goOnline(page);

  // Unpinning drops the copies.
  await page.getByRole("button", { name: "files", exact: true }).click();
  await page.getByRole("button", { name: "Actions for docs" }).click();
  await page.getByRole("menuitem", { name: "Stop keeping offline" }).click();
  await expect.poll(cached).toEqual([]);
});
