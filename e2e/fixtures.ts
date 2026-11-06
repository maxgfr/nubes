/** Each test gets its own in-memory GitHub, wired to api.github.com through page.route. */
import { test as base, type Page } from "@playwright/test";
import { createFakeGitHub, type FakeGitHub } from "../test/fake-github";

export const test = base.extend<{ gh: FakeGitHub }>({
  gh: async ({ page }, use) => {
    const fake = createFakeGitHub();
    fake.addRepo("octo/files");
    await page.route("https://api.github.com/**", async (route) => {
      const req = route.request();
      const body = req.postDataBuffer();
      const res = await fake.handle(
        new Request(req.url(), {
          method: req.method(),
          headers: req.headers(),
          ...(body && req.method() !== "GET" ? { body: new Uint8Array(body) } : {}),
        }),
      );
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: Buffer.from(await res.arrayBuffer()),
      });
    });
    await use(fake);
  },
});

export { expect } from "@playwright/test";

/** Opens “Use an existing repository instead” on the onboarding page. */
export async function useExisting(page: Page): Promise<void> {
  await page.getByText("Use an existing repository instead").click();
}

/** Signs in and picks octo/files. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/?nosw");
  await page.getByLabel("GitHub token").fill("test-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await useExisting(page);
  await page.getByRole("button", { name: /octo\/files/ }).click();
  await page
    .getByText(/Nothing here yet|files? ·/)
    .first()
    .waitFor();
}
