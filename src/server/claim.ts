import { audit } from "./audit";
import { db } from "./db";

// Claiming an unconfigured instance.
//
// A fresh deployment has no admin account, so the sign-up endpoint has to be
// reachable by someone with no credentials at all. What bounds it is time
// rather than a shared secret: the account can only be created within
// CLAIM_WINDOW of the process starting.
//
// The tradeoff is deliberate. A secret in an env var means digging through a
// hosting dashboard before you can use the thing, and it lives on in the
// deployment forever. A window closes on its own, so an instance that is
// spun up and forgotten stops being claimable instead of sitting open
// indefinitely — and reopening it takes a restart, which is a deliberate act
// by whoever controls the deployment.
export const CLAIM_WINDOW_MS = 30 * 60 * 1000;

// Rounded: this is user-facing copy, and a window that isn't a whole number of
// minutes would otherwise render as a long fraction.
export const CLAIM_WINDOW_MINUTES = Math.round(CLAIM_WINDOW_MS / 60_000);

// Milliseconds left in the window, 0 once it has closed. Measured from
// process start: a restart resets it, which is exactly the recovery path we
// tell a locked-out operator to use.
export function claimWindowRemainingMs(): number {
  return Math.max(0, CLAIM_WINDOW_MS - process.uptime() * 1000);
}

export function withinClaimWindow(): boolean {
  return claimWindowRemainingMs() > 0;
}

/**
 * How many admin accounts exist — or that we could not find out.
 *
 * The distinction is load-bearing. "Zero users" means this server is unclaimed
 * and anyone inside the window may create the admin account; it must only ever
 * be concluded from a query that actually succeeded. Treating a failed read as
 * zero turns a transient database problem on a live, configured server into an
 * open claim form, and past the window into a bogus "locked down, never
 * claimed" screen on a server that was working perfectly.
 */
export type UserCount = { known: true; count: number } | { known: false; error: string };

// Just enough of a database handle to run the count. Narrowed so the failure
// paths can be exercised against a scratch database, or a handle that throws,
// without a data directory on disk.
type CountSource = { prepare(sql: string): { get(): unknown } };

// The one failure that does mean "no users": Better Auth hasn't created its
// tables yet, on a first boot. Matched tightly — anything else, including a
// wording we don't recognise, is unknown rather than empty, which is the safe
// direction to be wrong in.
const NO_USER_TABLE = /^no such table: (\w+\.)?user$/i;

export function userCount(source: CountSource = db()): UserCount {
  try {
    const row = source.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
    return { known: true, count: row.n };
  } catch (e: unknown) {
    const message = String((e as { message?: string })?.message ?? e);
    if (NO_USER_TABLE.test(message)) return { known: true, count: 0 };
    audit("usercount.failed", { message });
    return { known: false, error: message };
  }
}

export async function isSetupComplete(source?: CountSource): Promise<boolean> {
  const c = userCount(source ?? db());
  // Fail closed: if we cannot tell, assume the server is already claimed.
  // Being wrong that way shows a signed-out admin a login page; being wrong the
  // other way offers a stranger the claim form on a live server.
  return c.known ? c.count > 0 : true;
}

/**
 * The single-admin invariant, inside the database.
 *
 * The sign-up hook counts users and refuses when there are any. That check
 * and Better Auth's insert are separated by awaits, so concurrent first
 * claims can all count zero and all succeed — ten requests, ten admins, and
 * nothing downstream tells them apart (NM-SEC-002, #50). The count is kept
 * for the friendly answer; this trigger is the boundary. It runs inside the
 * insert's own transaction, so count-and-refuse is one step, and it holds
 * for any process that opens the file.
 *
 * A trigger rather than a constraint: SQLite will not index an expression
 * that references no column, so "at most one row" has no constraint form.
 */
export const SINGLE_ADMIN_TRIGGER = `CREATE TRIGGER IF NOT EXISTS single_admin
BEFORE INSERT ON "user"
WHEN (SELECT COUNT(*) FROM "user") > 0
BEGIN SELECT RAISE(ABORT, 'already claimed'); END;`;

type ExecSource = { exec(sql: string): unknown };

/** Install the guard. Idempotent; the user table must already exist. */
export function installSingleAdminGuard(source: ExecSource = db()): void {
  source.exec(SINGLE_ADMIN_TRIGGER);
}

/** True for the error an insert gets when the guard refuses it. */
export function isSingleAdminRefusal(e: unknown): boolean {
  return /already claimed/.test(String((e as { message?: string })?.message ?? e));
}

/**
 * Accounts beyond the one this server should have. Zero when it cannot tell:
 * an unreadable database is not a reason to alarm the operator about admins.
 */
export function extraAdminAccounts(source: CountSource = db()): number {
  const c = userCount(source);
  return c.known ? Math.max(0, c.count - 1) : 0;
}
