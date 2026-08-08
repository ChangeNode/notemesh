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
/**
 * Put a session in the browser without navigating anywhere.
 *
 * Split out from signIn because the wizard tests land on /setup rather than the
 * dashboard, and signIn waits for a URL pattern that only matches a trailing
 * slash — so on an instance mid-setup it timed out, and the failure read as
 * sign-in itself being broken.
 */
async function seedSession(page: Page) {
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
}

async function signIn(page: Page) {
  await seedSession(page);
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

test.describe("on a phone", () => {
  // The tab row is six items wide and did not wrap, so on a narrow screen it
  // ran off the side and the last tabs were unreachable.
  test.use({ viewport: { width: 375, height: 812 } });

  test("wraps the tabs instead of running off the screen", async ({ page }) => {
    await signIn(page);

    const tabs = ["Setup", "Tools", "Status", "Keys", "Settings", "Security"];
    for (const label of tabs) {
      await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
    }

    // Nothing may sit outside the viewport horizontally.
    const viewport = page.viewportSize()!.width;
    for (const label of tabs) {
      const box = (await page.getByRole("link", { name: label, exact: true }).boundingBox())!;
      expect(box.x, `${label} starts off-screen`).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width, `${label} runs past the right edge`).toBeLessThanOrEqual(viewport + 1);
    }

    // And the page itself must not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the page scrolls horizontally").toBeLessThanOrEqual(1);

    // Wrapped, not shrunk into illegibility.
    const rows = new Set<number>();
    for (const label of tabs) {
      rows.add(Math.round((await page.getByRole("link", { name: label, exact: true }).boundingBox())!.y));
    }
    expect(rows.size, "six tabs on one 375px row would mean they are too small").toBeGreaterThan(1);
  });

  test("keeps the header and a usable page below it", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("a.brand img.brand-mark")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible();
    // The tab row must not have pushed the content off the bottom either.
    await expect(page.getByText("Set up your client")).toBeVisible();
  });
});

test.describe("the sync controls", () => {
  test("offer no Sync Now while continuous sync is running", async ({ page }) => {
    // Reported from use: pressing it under a running daemon logged "[admin]
    // Error: manual sync failed. Another sync instance is already running for
    // this vault." `ob sync` locks the vault, so the one-shot could not have
    // worked — and the daemon was already doing the thing being asked for.
    await signIn(page);
    await page.getByRole("link", { name: "Status", exact: true }).click();

    // The controls that do apply are still there, so this is the button being
    // absent rather than the whole row failing to render.
    await expect(page.getByRole("button", { name: "Stop Sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restart Sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rebuild Index" })).toBeVisible();

    await expect(page.getByRole("button", { name: "Sync Now" })).toHaveCount(0);
  });

  test("relabel themselves for a stopped service", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Status", exact: true }).click();

    // Running: the service is the thing you stop or restart, and a one-off
    // sync is not offered at all on the Obsidian backend.
    await expect(page.getByRole("button", { name: "Stop Sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Restart Sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start Sync Service" })).toHaveCount(0);

    await page.getByRole("button", { name: "Stop Sync" }).click();

    // Stopped: starting it again is the primary action, a one-off sync is
    // secondary, and there is nothing left to stop.
    const start = page.getByRole("button", { name: "Start Sync Service" });
    await expect(start).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Manual Sync" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop Sync" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restart Sync" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sync Now" })).toHaveCount(0);

    // Emphasis: Pico renders a secondary button with the class, so the primary
    // is the one without it.
    await expect(start).not.toHaveClass(/secondary/);
    await expect(page.getByRole("button", { name: "Manual Sync" })).toHaveClass(/secondary/);

    // And back, so the shared server is left as it was found.
    await start.click();
    await expect(page.getByRole("button", { name: "Stop Sync" })).toBeVisible({ timeout: 15_000 });
  });

  test("show the stop without a visible page rebuild", async ({ page }) => {
    // The Show around this page used to be keyed, so every refetch resolved a
    // fresh object, tore the subtree down and rebuilt it — which read as the
    // page reloading. Marking a node and finding it still there afterwards is
    // what tells the two apart.
    await signIn(page);
    await page.getByRole("link", { name: "Status", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop Sync" })).toBeVisible();

    await page.locator("pre.logs").evaluate((el) => el.setAttribute("data-marker", "kept"));
    await page.getByRole("button", { name: "Stop Sync" }).click();
    await expect(page.getByRole("button", { name: "Start Sync Service" })).toBeVisible({
      timeout: 15_000,
    });

    // Survives only if the DOM was updated in place.
    await expect(page.locator('pre.logs[data-marker="kept"]')).toHaveCount(1);

    await page.getByRole("button", { name: "Start Sync Service" }).click();
    await expect(page.getByRole("button", { name: "Stop Sync" })).toBeVisible({ timeout: 15_000 });
  });

  test("bring a manual sync back once the service is stopped", async ({ page }) => {
    // The other half: hidden while running must not mean gone for good, or a
    // stopped instance would have no way to sync by hand.
    await signIn(page);
    await page.getByRole("link", { name: "Status", exact: true }).click();
    await page.getByRole("button", { name: "Stop Sync" }).click();

    await expect(page.getByRole("button", { name: "Manual Sync" })).toBeVisible({ timeout: 15_000 });

    // Leave the instance as it was found — the tests share one server.
    await page.getByRole("button", { name: "Start Sync Service" }).click();
    await expect(page.getByRole("button", { name: "Manual Sync" })).toHaveCount(0, {
      timeout: 15_000,
    });
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

  test("offers a route to update notifications, without loading anything", async ({ page }) => {
    // The server cannot mail its operator, so this link is the only standing
    // way they hear about a security fix. It is a link on purpose: an embedded
    // signup form would put a third-party script in the origin that holds the
    // admin session.
    const requests: string[] = [];
    page.on("request", (r) => {
      const host = new URL(r.url()).host;
      if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) requests.push(r.url());
    });

    await signIn(page);
    const link = page.getByRole("link", { name: "Update notifications" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://changenode.com/notemesh-thanks/");
    await expect(link).toHaveAttribute("rel", /noopener/);

    // Nothing off-origin is fetched merely by rendering the page — no CDN
    // script, no tracker, nothing until someone clicks.
    expect(requests, "the admin UI must not contact anything off-origin").toEqual([]);
  });

  test("spells the product NoteMesh where a person reads it", async ({ page }) => {
    await signIn(page);
    await expect(page.locator("a.brand strong")).toHaveText("NoteMesh");
    await expect(page).toHaveTitle("NoteMesh");
    await expect(page.getByRole("link", { name: "NoteMesh on GitHub" })).toBeVisible();
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

test.describe("the vault step", () => {
  /** Open the seeded instance's database. */
  async function openDb() {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const state = JSON.parse(
      fs.readFileSync(path.join(os.tmpdir(), "notemesh-e2e-state.json"), "utf8"),
    ) as { dataDir: string };
    return new Database(path.join(state.dataDir, "app.sqlite"));
  }

  test("keeps the encryption password folded away, and still submits it", async ({ page }) => {
    // Blank is right for most vaults — Obsidian Sync defaults to managed
    // encryption — and an open password box during an Obsidian sign-in flow
    // invites the account password, which is the wrong secret entirely.
    //
    // Reached by clearing vault_configured on the shared instance. Restored in
    // `finally` rather than by completing the step, so an assertion failure
    // cannot strand every test that runs after this one.
    const db = await openDb();
    db.prepare("DELETE FROM settings WHERE key = 'vault_configured'").run();
    db.close();

    try {
      await seedSession(page);
      await page.goto("/setup");
      await expect(page.getByText("Choose a vault")).toBeVisible({ timeout: 15_000 });

      // The picker is the visible decision; the password is not.
      await expect(page.locator("#vault-select")).toBeVisible();
      const pw = page.locator("#vault-password");
      await expect(pw).toBeHidden();

      // It is in the DOM though, so its value still reaches the form.
      await expect(pw).toHaveCount(1);

      await page.getByText("My vault is end-to-end encrypted").click();
      await expect(pw).toBeVisible();
      await expect(pw).toHaveAttribute("type", "password");

      // Closing it again does not lose what was typed.
      await pw.fill("a-vault-password");
      await page.getByText("My vault is end-to-end encrypted").click();
      await expect(pw).toBeHidden();
      await expect(pw).toHaveValue("a-vault-password");
    } finally {
      const restore = await openDb();
      restore
        .prepare(
          "INSERT INTO settings (key,value) VALUES ('vault_configured','true') " +
            "ON CONFLICT(key) DO UPDATE SET value='true'",
        )
        .run();
      restore.close();
    }
  });
});

test.describe("the notifications step", () => {
  // The wizard's last step, and the only one that gates on an acknowledgement.
  // Driven against the shared server by clearing the setting that marks it done
  // — completing the step writes it back, so finishing the test restores the
  // instance for everything after it. Playwright runs one worker, so nothing
  // interleaves with this.
  test("gates Continue on the checkbox, then completes setup", async ({ page }) => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const Database = (await import("better-sqlite3")).default;

    const state = JSON.parse(
      fs.readFileSync(path.join(os.tmpdir(), "notemesh-e2e-state.json"), "utf8"),
    ) as { dataDir: string };
    const db = new Database(path.join(state.dataDir, "app.sqlite"));
    db.prepare("DELETE FROM settings WHERE key = 'notifications_acknowledged'").run();
    db.close();

    await seedSession(page);
    await page.goto("/setup");

    await expect(page.getByText("Security and Update Notifications")).toBeVisible();
    // Last step of the wizard, not an extra screen after it.
    await expect(page.getByText(/Step 6 of 6/)).toBeVisible();

    const cont = page.getByRole("button", { name: "Continue" });
    await expect(cont).toBeDisabled();

    // The signup is a button to press, but still an anchor underneath — so it
    // keeps a link's behaviour and loads nothing until it is clicked.
    const signup = page.getByRole("button", { name: "Sign Up for Update Notifications" });
    await expect(signup).toHaveAttribute("href", "https://changenode.com/notemesh-thanks/");
    await expect(signup).toHaveAttribute("target", "_blank");
    await expect(signup).toHaveAttribute("rel", /noopener/);

    await page.getByRole("checkbox").check();
    await expect(cont).toBeEnabled();
    await cont.click();

    await expect(page.getByText("Setup complete")).toBeVisible({ timeout: 15_000 });
    // The card moved out of the finish screen — it is a step now, not something
    // to scroll past under a "Go to Dashboard" button.
    await expect(page.getByText("Security and Update Notifications")).toHaveCount(0);
  });

  test("stays done once acknowledged", async ({ page }) => {
    // The previous test wrote the setting by completing the step; revisiting
    // must not ask again.
    await signIn(page);
    await page.goto("/setup");
    await expect(page.getByText("Setup complete")).toBeVisible();
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
