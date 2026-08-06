import type * as Admin from "~/server/admin";
import type * as Setup from "~/server/setup";
import type * as Reset from "~/server/reset-actions";

/**
 * The browser's half of the boundary.
 *
 * Every call goes over HTTP to /api/rpc/<name>. Nothing here imports server code
 * at runtime — only `import type`, which TypeScript erases, so the signatures
 * below stay in step with the implementations without putting a single server
 * module in the client bundle. If one ever creeps in, scripts/check-client-bundle
 * fails the build.
 *
 * This is what replaced SolidStart's `"use server"` functions. Those imported
 * the real module into the component and relied on the compiler to strip the
 * body; a directive on a function does nothing about the imports at the top of
 * its file, which is how better-sqlite3 reached the browser and broke sign-in.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    /**
     * Set when the server hit something unexpected. The same value is printed
     * beside the stack trace in the server log, so an operator reading "it
     * broke" on screen can find the one log line that explains it without the
     * detail being shown to whoever asked.
     */
    readonly errorId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(fn: string, args: unknown[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Cookies carry the session; the server checks it per call.
      credentials: "same-origin",
      body: JSON.stringify(args),
    });
  } catch (e: unknown) {
    // fetch only rejects when the request never completed, so this is the
    // server being unreachable rather than the call failing.
    throw new ApiError(
      `Could not reach the server. ${String((e as { message?: string })?.message ?? "")}`.trim(),
      0,
      "network",
    );
  }

  let body: { result?: unknown; error?: string; message?: string; errorId?: string } = {};
  try {
    body = await res.json();
  } catch {
    throw new ApiError(`The server returned an unreadable response (${res.status}).`, res.status, "malformed");
  }

  if (!res.ok) {
    throw new ApiError(
      body.message ?? `Request failed (${res.status}).`,
      res.status,
      body.error ?? "failed",
      body.errorId,
    );
  }
  return body.result as T;
}

// Signatures mirror the server functions exactly, so a change on either side is
// a type error rather than a runtime surprise.
type P<T> = T extends (...a: infer A) => infer R ? (...a: A) => R : never;

export const api = {
  // ---- Dashboard ----
  getSetupPage: (() => call("getSetupPage")) as P<typeof Admin.getSetupPage>,
  getKeysPage: (() => call("getKeysPage")) as P<typeof Admin.getKeysPage>,
  getStatusPage: (() => call("getStatusPage")) as P<typeof Admin.getStatusPage>,
  getSettingsPage: (() => call("getSettingsPage")) as P<typeof Admin.getSettingsPage>,
  getToolsPage: (() => call("getToolsPage")) as P<typeof Admin.getToolsPage>,
  getSecurityPage: (() => call("getSecurityPage")) as P<typeof Admin.getSecurityPage>,
  getSyncActivity: (() => call("getSyncActivity")) as P<typeof Admin.getSyncActivity>,

  createApiKey: ((name: string) => call("createApiKey", [name])) as P<typeof Admin.createApiKey>,
  deleteApiKey: ((id: string) => call("deleteApiKey", [id])) as P<typeof Admin.deleteApiKey>,
  revokeOAuthClient: ((id: string) =>
    call("revokeOAuthClient", [id])) as P<typeof Admin.revokeOAuthClient>,

  setGitTiming: ((d: number, p: number) =>
    call("setGitTiming", [d, p])) as P<typeof Admin.setGitTiming>,
  setGitConflictStrategy: ((s: string) =>
    call("setGitConflictStrategy", [s])) as P<typeof Admin.setGitConflictStrategy>,
  setTimezone: ((tz: string) => call("setTimezone", [tz])) as P<typeof Admin.setTimezone>,
  setDeleteEnabled: ((on: boolean) =>
    call("setDeleteEnabled", [on])) as P<typeof Admin.setDeleteEnabled>,

  syncNow: (() => call("syncNow")) as P<typeof Admin.syncNow>,
  stopSync: (() => call("stopSync")) as P<typeof Admin.stopSync>,
  restartSync: (() => call("restartSync")) as P<typeof Admin.restartSync>,
  rebuildIndex: (() => call("rebuildIndex")) as P<typeof Admin.rebuildIndex>,
  reauth: ((input: { email?: string; password?: string; mfa?: string }) =>
    call("reauth", [input])) as P<typeof Admin.reauth>,

  // ---- Setup wizard ----
  getSetupStage: (() => call("getSetupStage")) as P<typeof Setup.getSetupStage>,
  getSetupProgress: (() => call("getSetupProgress")) as P<typeof Setup.getSetupProgress>,
  getClaimState: (() => call("getClaimState")) as P<typeof Setup.getClaimState>,
  relinkVault: (() => call("relinkVault")) as P<typeof Setup.relinkVault>,
  setupChooseBackend: ((kind: "obsidian" | "git") =>
    call("setupChooseBackend", [kind])) as P<typeof Setup.setupChooseBackend>,
  setupGitRepo: ((remote: string, branch: string, username: string, token: string) =>
    call("setupGitRepo", [remote, branch, username, token])) as P<typeof Setup.setupGitRepo>,
  setupObsidianLogin: ((email: string, password: string, mfa?: string) =>
    call("setupObsidianLogin", [email, password, mfa])) as P<typeof Setup.setupObsidianLogin>,
  setupListVaults: (() => call("setupListVaults")) as P<typeof Setup.setupListVaults>,
  setupConfigureVault: ((vault: string, password?: string) =>
    call("setupConfigureVault", [vault, password])) as P<typeof Setup.setupConfigureVault>,

  // ---- Admin password reset ----
  getResetState: (() => call("getResetState")) as P<typeof Reset.getResetState>,
  submitAdminReset: ((pin: string, password: string) =>
    call("submitAdminReset", [pin, password])) as P<typeof Reset.submitAdminReset>,
};
