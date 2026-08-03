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
