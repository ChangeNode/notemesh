import crypto from "node:crypto";
import { audit } from "./audit";
import { db } from "./db";
import { claimWindowRemainingMs, CLAIM_WINDOW_MINUTES } from "./claim";

/**
 * Recovering an admin password without email, and without a shell.
 *
 * The problem this solves: a single-user server with no mail transport has no
 * way to prove who you are once the password is gone. Other self-hosted servers
 * answer it by asking you to prove something only the operator can — read a file
 * off the server's disk (Jellyfin), run a CLI inside the install (Nextcloud,
 * Grafana), or set a privileged environment variable (Vaultwarden's
 * ADMIN_TOKEN). The last one fits a platform deployment best: setting a variable
 * is something the operator can already do, in a dashboard they already have,
 * and it takes effect on the redeploy the platform performs anyway.
 *
 * So: set RESET_ADMIN_FLOW=1 and redeploy. The server prints an eight-digit PIN
 * to its log — which only someone who can read the deployment's logs can see —
 * and accepts that PIN, once, to set a new password. It is bounded three ways:
 * the variable has to be set, the PIN only lives in this process, and the window
 * closes CLAIM_WINDOW_MINUTES after boot, exactly like claiming an unclaimed
 * server does.
 *
 * Deliberately not persisted anywhere. Vaultwarden's admin token is written into
 * config.json on first use and then takes precedence over the environment, so
 * removing the variable does not disable the panel — a recovery mechanism that
 * outlives its own switch is a backdoor. Nothing here is written to the
 * database; drop the variable and the flow is gone on the next boot.
 */

// Exactly "1". A recovery path should not be ambiguous about whether it is
// armed, and "0"/"false"/"no" must never read as on.
export function resetFlowEnabled(): boolean {
  return process.env.RESET_ADMIN_FLOW === "1";
}

// Ten guesses per boot, against 10^8 possible PINs. A restart is what grants
// more, and a restart also issues a new PIN and restarts the window — so
// grinding costs an attacker a full redeploy per ten attempts, on a deployment
// they would already need to control.
export const MAX_PIN_ATTEMPTS = 10;

interface ResetProcessState {
  pin: string;
  attempts: number;
  used: boolean;
  // On the shared object rather than a module-level flag: the bundler
  // instantiates this module in more than one chunk, so module scope is not
  // once per process. Observed — the PIN was printed twice on one boot (the
  // same PIN, since that already lived here, but two blocks in the log).
  announced: boolean;
}

// Module-level, so the PIN and the attempt count live and die with the process.
const globalKey = "__obSyncAdminReset";
function state(): ResetProcessState {
  const g = globalThis as unknown as Record<string, ResetProcessState | undefined>;
  if (!g[globalKey]) {
    g[globalKey] = {
      // randomInt, not Math.random: this is the only thing standing between a
      // stranger and the admin account while the flow is armed.
      pin: String(crypto.randomInt(0, 100_000_000)).padStart(8, "0"),
      attempts: 0,
      used: false,
      announced: false,
    };
  }
  return g[globalKey]!;
}

/**
 * Print the PIN once per boot, if the flow is armed.
 *
 * Idempotent, and called from middleware for the same reason the sync daemon is
 * — there is no other reliable "the server has started" hook. Writing it to
 * stdout is the whole mechanism: on a hosted platform the logs are visible to
 * whoever controls the deployment and to nobody else.
 */
export function announceResetFlow(): void {
  if (!resetFlowEnabled()) return;
  const s = state();
  if (s.announced) return;
  s.announced = true;
  audit("reset.armed", { windowMinutes: CLAIM_WINDOW_MINUTES });
  console.log(
    [
      "",
      "==================== ADMIN PASSWORD RESET ARMED ====================",
      `  RESET_ADMIN_FLOW is set, so this server will accept a one-time`,
      `  password reset for the next ${CLAIM_WINDOW_MINUTES} minutes.`,
      "",
      `      PIN:  ${s.pin}`,
      "",
      "  Open /reset on this server and enter it. When you are done, REMOVE",
      "  the RESET_ADMIN_FLOW variable — while it is set, every restart",
      "  issues a new PIN and reopens this window.",
      "====================================================================",
      "",
    ].join("\n"),
  );
}

export type ResetState =
  | { mode: "off" }
  | { mode: "open"; secondsLeft: number; windowMinutes: number }
  | { mode: "expired"; windowMinutes: number }
  | { mode: "exhausted"; windowMinutes: number };

// Safe to hand to an unauthenticated page: says whether the flow is armed and
// how long is left, never the PIN.
export function resetState(): ResetState {
  if (!resetFlowEnabled()) return { mode: "off" };
  const s = state();
  if (s.attempts >= MAX_PIN_ATTEMPTS) {
    return { mode: "exhausted", windowMinutes: CLAIM_WINDOW_MINUTES };
  }
  const left = claimWindowRemainingMs();
  if (left <= 0) return { mode: "expired", windowMinutes: CLAIM_WINDOW_MINUTES };
  return {
    mode: "open",
    secondsLeft: Math.floor(left / 1000),
    windowMinutes: CLAIM_WINDOW_MINUTES,
  };
}

/**
 * Which card the sign-in page should show.
 *
 * A pure mapping, and its own function, because the sign-in page originally
 * branched on "is the flow armed" — one bit for three states — and so told
 * someone whose window had closed that they could reset with the PIN from the
 * log. The bug is invisible on the happy path: reaching either bad state needs
 * a 30-minute wait or ten spent guesses. Deciding it here means the decision can
 * be checked against every mode without a browser.
 */
export type ResetBanner =
  /** Not armed: fold away the how-to. */
  | "instructions"
  /** Armed and usable: link to the reset page. */
  | "armed"
  /** Armed but out of window or attempts: say so, and do not offer the link. */
  | "unusable";

export function resetBanner(state: ResetState): ResetBanner {
  switch (state.mode) {
    case "off":
      return "instructions";
    case "open":
      return "armed";
    case "expired":
    case "exhausted":
      return "unusable";
  }
}

// Length is not a secret — the PIN is always eight digits — so comparing it
// first costs nothing. The digits themselves go through timingSafeEqual so a
// guess cannot be refined one character at a time.
export function pinMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface ResetOutcome {
  ok: boolean;
  message?: string;
  /** Set on success, so the page can say which account was changed. */
  email?: string;
  attemptsLeft?: number;
}

/**
 * Verify the PIN and set a new admin password.
 *
 * Every failure burns an attempt, including ones rejected for a bad password —
 * otherwise the password field becomes a free oracle for testing PINs.
 */
export async function performAdminReset(pin: string, newPassword: string): Promise<ResetOutcome> {
  if (!resetFlowEnabled()) {
    return { ok: false, message: "Password reset is not enabled on this server." };
  }
  const s = state();
  if (s.attempts >= MAX_PIN_ATTEMPTS) {
    audit("reset.rejected", { reason: "attempts_exhausted" });
    return {
      ok: false,
      message: `Too many attempts. Restart the server to get a new PIN and another ${CLAIM_WINDOW_MINUTES} minutes.`,
    };
  }
  if (claimWindowRemainingMs() <= 0) {
    audit("reset.rejected", { reason: "window_closed" });
    return {
      ok: false,
      message: `The ${CLAIM_WINDOW_MINUTES}-minute reset window has closed. Restart the server to reopen it.`,
    };
  }

  s.attempts += 1;
  const attemptsLeft = MAX_PIN_ATTEMPTS - s.attempts;

  if (!pinMatches(pin.trim(), s.pin)) {
    audit("reset.rejected", { reason: "bad_pin", attemptsLeft });
    return { ok: false, message: "That PIN is not correct.", attemptsLeft };
  }
  if (newPassword.length < 10) {
    audit("reset.rejected", { reason: "weak_password", attemptsLeft });
    return { ok: false, message: "Choose a password of at least 10 characters.", attemptsLeft };
  }

  const rows = db().prepare('SELECT id, email FROM "user" ORDER BY createdAt LIMIT 2').all() as {
    id: string;
    email: string;
  }[];
  if (rows.length !== 1) {
    // Zero means nothing to reset — the claim flow applies instead. More than
    // one should be impossible on a single-user server, and guessing which
    // account was meant is not a decision to make silently.
    audit("reset.rejected", { reason: "unexpected_user_count", count: rows.length });
    return {
      ok: false,
      message:
        rows.length === 0
          ? "This server has no admin account yet — open /setup to claim it."
          : "This server has more than one account, so there is no single admin to reset.",
      attemptsLeft,
    };
  }
  const user = rows[0];

  // Imported here rather than at module scope: auth.ts builds the Better Auth
  // instance on import, which needs ENCRYPTION_KEY and opens the database.
  const { auth } = await import("./auth");
  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(user.id, await ctx.password.hash(newPassword));

  // Any session issued before the reset belongs to whoever had the old
  // password. Drop them all; the operator signs in again with the new one.
  db().prepare('DELETE FROM "session" WHERE userId = ?').run(user.id);

  s.used = true;
  audit("reset.succeeded", { user: user.id });
  return { ok: true, email: user.email };
}
