import { performAdminReset, resetState, type ResetOutcome, type ResetState } from "./reset";
import { runAuthMigrations } from "./auth";

// Server-function wrappers for the reset flow. Both are deliberately
// unauthenticated — the whole point is that nobody can sign in — so what
// protects them is the environment variable, the PIN, the window, and the
// attempt cap in reset.ts, not a session.

export async function getResetState(): Promise<ResetState> {
  "use server";
  return resetState();
}

export async function submitAdminReset(pin: string, newPassword: string): Promise<ResetOutcome> {
  "use server";
  // The user table has to exist before it can be read.
  await runAuthMigrations();
  return performAdminReset(pin, newPassword);
}
