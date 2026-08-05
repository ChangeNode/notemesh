import { expect, test, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./server";

/**
 * The failures a browser sees and nothing else does.
 *
 * Every bug that reached a user in this app lived here: a component that threw
 * on load so the sign-in form silently native-submitted, a client-only API
 * called during server rendering, a button whose label wrapped. None of them
 * were visible to TypeScript, the unit suite, or the HTTP suite — a route can
 * return a perfectly good 200 whose JavaScript then fails to run.
 *
 * So these assert what a person would notice: that a page renders, that a form
 * does something, and that no uncaught error reached the console on the way.
 */

/** Fail a test if the page logged an error or threw, not just if an assertion did. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  return errors;
}

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/", { timeout: 15_000 });
}

test.describe("signing in", () => {
  test("lands on the dashboard and renders it", async ({ page }) => {
    // The regression this exists for: the form submitted, the page reloaded,
    // the fields cleared and nothing else happened, because the component had
    // failed to load and the browser fell back to a native submit.
    const errors = watchForErrors(page);
    await signIn(page);

    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("link", { name: "Setup" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Uncaught");
    expect(errors).toEqual([]);
  });

  test("stays put and explains itself when the password is wrong", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign In" }).click();

    // An error, on the same page — not a silent reload, which is what a broken
    // submit handler looks like.
    await expect(page.locator(".error")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("sends a signed-out visitor to the login page", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/status");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("every tab renders", () => {
  // A page that throws on render returns a perfectly good 200 first, so only a
  // browser can tell the difference.
  const TABS = [
    ["Setup", "/", "Set up your client"],
    ["Status", "/status", "Sync log"],
    ["Keys", "/keys", "API keys"],
    ["Settings", "/settings", "Vault writes"],
    ["Security", "/security", "Exposure"],
  ] as const;

  for (const [label, path, heading] of TABS) {
    test(`${label} renders without an uncaught error`, async ({ page }) => {
      const errors = watchForErrors(page);
      await signIn(page);
      await page.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/$" : path}`));
      await expect(page.getByText(heading).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.locator("body")).not.toContainText("Uncaught");
      expect(errors).toEqual([]);
    });
  }
});

test.describe("creating an API key", () => {
  test("shows the key once and lists it", async ({ page }) => {
    const errors = watchForErrors(page);
    await signIn(page);
    await page.getByRole("link", { name: "Keys", exact: true }).click();

    await page.getByLabel("Key name").fill("e2e-key");
    await page.getByRole("button", { name: "Create Key" }).click();

    await expect(page.getByText("New key — copy it now.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("cell", { name: "e2e-key" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the Create Key button keeps its label on one line", async ({ page }) => {
    // Regression: the button shrank below its label inside Pico's role=group
    // and broke "Create Key" across two lines. Height is the observable part —
    // a wrapped label is roughly double.
    await signIn(page);
    await page.getByRole("link", { name: "Keys", exact: true }).click();
    const button = page.getByRole("button", { name: "Create Key" });
    await expect(button).toBeVisible();

    const box = await button.boundingBox();
    const lines = await button.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getClientRects().length;
    });
    expect(lines).toBe(1);
    expect(box!.height).toBeLessThan(70);
  });
});

test.describe("password reset", () => {
  test("is folded away when the flow is not armed", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("How To Reset Your Admin Password")).toBeVisible();
    // The armed card must not appear on a server that has not armed it.
    await expect(page.getByText("Password reset is armed")).toHaveCount(0);
  });

  test("the reset page refuses when the flow is off", async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto("/reset");
    await expect(page.getByText("Password reset is not enabled")).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});

test.describe("signing out", () => {
  test("ends the session and blocks the dashboard again", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Sign Out" }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);
  });
});
