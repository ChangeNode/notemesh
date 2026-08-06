import { expect, request, test, type Cookie, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from "./server";

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

/**
 * Sign in the way a person does. For the tests that are *about* signing in.
 */
async function signInThroughTheForm(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL("**/", { timeout: 15_000 });
}

let sessionCookies: Cookie[] | null = null;

/**
 * Arrive already signed in. For every test whose subject is a page behind the
 * login, not the login itself.
 *
 * Driving the form in each of those cost one sign-in apiece and ran the suite
 * into Better Auth's rate limit on /sign-in/email (10 per 60s), which is a
 * production setting worth keeping — the failure looked like a broken sign-in
 * page, and every test after the tenth failed the same way whatever it was
 * testing. One real sign-in is made here and its session reused, so adding a
 * test no longer spends a request against that budget.
 */
async function signIn(page: Page) {
  if (!sessionCookies) {
    const ctx = await request.newContext({ baseURL: BASE_URL });
    const res = await ctx.post("/api/auth/sign-in/email", {
      // Under NODE_ENV=production Better Auth refuses a request with no Origin.
      headers: { Origin: BASE_URL },
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!res.ok()) throw new Error(`could not sign in (${res.status()}): ${await res.text()}`);
    sessionCookies = (await ctx.storageState()).cookies;
    await ctx.dispose();
  }
  await page.context().addCookies(sessionCookies);
  await page.goto("/");
  await page.waitForURL("**/", { timeout: 15_000 });
}

test.describe("signing in", () => {
  test("lands on the dashboard and renders it", async ({ page }) => {
    // The regression this exists for: the form submitted, the page reloaded,
    // the fields cleared and nothing else happened, because the component had
    // failed to load and the browser fell back to a native submit. So this one
    // has to go through the form — a seeded cookie would prove nothing.
    const errors = watchForErrors(page);
    await signInThroughTheForm(page);

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
    ["Tools", "/tools", "MCP tools"],
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

test.describe("the connect instructions", () => {
  test("keep only one disclosure open at a time", async ({ page }) => {
    await signIn(page);
    // Every disclosure in the card, not just the ones wearing the attribute
    // that makes this work — otherwise a panel that drops out of the group
    // leaves the locator too, and the count assertion fails in its place while
    // the exclusivity assertion below never gets a chance to.
    const panels = page.locator("article details");
    await expect(panels).toHaveCount(5);

    const openCount = async () => await panels.evaluateAll((els) => els.filter((e) => (e as HTMLDetailsElement).open).length);

    // Starts on the TL;DR, which is the one nearly every client needs.
    expect(await openCount()).toBe(1);
    await expect(panels.first()).toHaveAttribute("open", "");

    // Opening another closes it, rather than stacking.
    await page.getByText("Claude Code", { exact: true }).click();
    expect(await openCount()).toBe(1);
    await expect(panels.first()).not.toHaveAttribute("open", "");

    // And again, from one non-default panel to another — the case that would
    // still stack if only the first were special-cased.
    await page.getByText("Codex", { exact: true }).click();
    expect(await openCount()).toBe(1);
  });
});

test.describe("branding", () => {
  test("the header shows the mark beside the wordmark", async ({ page }) => {
    const errors = watchForErrors(page);
    await signIn(page);

    const mark = page.locator("a.brand img.brand-mark");
    await expect(mark).toBeVisible();

    // Visible is not the same as loaded — a broken src still occupies a box and
    // still passes toBeVisible. naturalWidth is 0 until the image decodes.
    const loaded = await mark.evaluate((el) => (el as HTMLImageElement).naturalWidth > 0);
    expect(loaded, "the brand mark resolved and decoded").toBe(true);

    // Upper left, on the same line as the wordmark it belongs to.
    const markBox = (await mark.boundingBox())!;
    const wordBox = (await page.locator("a.brand strong").boundingBox())!;
    expect(markBox.x).toBeLessThan(wordBox.x);
    expect(Math.abs(markBox.height - markBox.width)).toBeLessThan(2); // still square
    expect(markBox.y + markBox.height).toBeGreaterThan(wordBox.y);
    expect(markBox.y).toBeLessThan(wordBox.y + wordBox.height);

    expect(errors).toEqual([]);
  });

  test("the footer credits ChangeNode, signed in or not", async ({ page }) => {
    // The footer is on the signed-out pages too, so check both — they render
    // through different route trees.
    await page.goto("/login");
    const link = page.getByRole("link", { name: "ChangeNode", exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://changenode.com");
    // Opens a new tab, so it needs the opener severed.
    await expect(link).toHaveAttribute("rel", /noopener/);

    await signIn(page);
    await expect(page.getByRole("link", { name: "ChangeNode", exact: true })).toBeVisible();
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
    // Its own session, through the form: signing out revokes the session server
    // side, and revoking the shared one would strand every test that runs after
    // this — a failure that would depend on declaration order.
    await signInThroughTheForm(page);
    await page.getByRole("button", { name: "Sign Out" }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    await page.goto("/settings");
    await expect(page).toHaveURL(/\/login/);
  });
});
