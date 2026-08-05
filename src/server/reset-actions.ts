import type { ResetOutcome } from "./reset";
import type { ResetState } from "../lib/reset-view";

// Server-function wrappers for the reset flow. Both are deliberately
// unauthenticated — the whole point is that nobody can sign in — so what
// protects them is the environment variable, the PIN, the window, and the
// attempt cap in reset.ts, not a session.
//
// The implementation is imported inside each function rather than at module
// scope. "use server" replaces these bodies with an RPC stub in the client
// build, but a top-level import is still an edge in the module graph, so
// server/reset.ts and everything it reaches ended up in the browser bundle.
// Only types cross the boundary up here, and types are erased.

export async function getResetState(): Promise<ResetState> {
  "use server";
  const { resetState } = await import("./reset");
  return resetState();
}

export async function submitAdminReset(pin: string, newPassword: string): Promise<ResetOutcome> {
  "use server";
  const { runAuthMigrations } = await import("./auth");
  const { performAdminReset } = await import("./reset");
  // The user table has to exist before it can be read.
  await runAuthMigrations();
  return performAdminReset(pin, newPassword);
}
