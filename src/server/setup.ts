import { getRequestEvent } from "solid-js/web";
import { getSetting, setSetting } from "./db";
import { env, detectOriginMismatch, type OriginMismatch } from "./env";
import { runAuthMigrations } from "./auth";
import { isSetupComplete, claimWindowRemainingMs, CLAIM_WINDOW_MINUTES } from "./claim";
import {
  obLogin,
  obListRemoteVaults,
  obIsAuthenticated,
  obSyncSetup,
  obSyncStatus,
  looksLikeMfaRequired,
  looksLikeAuthFailure,
  type RemoteVault,
} from "./ob/cli";
import { storeObsidianAccount, storeVaultPassword } from "./ob/credentials";
import { syncBackend } from "./sync";
import { requireAdmin } from "./session";
import { probeRemote, cloneVault, repoDisplayName } from "./sync/git";
import { storeGitCredentials, clearGitCredentials } from "./sync/git-credentials";

export type SetupStage =
  | "admin" // no admin account yet — wizard step 1
  | "backend" // admin exists, hasn't chosen how the vault syncs
  | "obsidian-login" // Obsidian backend: account not linked
  | "vault" // Obsidian backend: logged in, vault not chosen
  | "git" // git backend: repo not linked
  | "done";

async function computeStage(): Promise<SetupStage> {
  await runAuthMigrations();
  if (!(await isSetupComplete())) return "admin";
  const backend = getSetting("sync_backend");
  if (!backend) return "backend";
  if (backend === "git") {
    return getSetting("vault_configured") === "true" ? "done" : "git";
  }
  if (getSetting("obsidian_logged_in") !== "true") return "obsidian-login";
  if (getSetting("vault_configured") !== "true") return "vault";
  return "done";
}

export async function setupChooseBackend(kind: "obsidian" | "git"): Promise<{ ok: boolean }> {
  "use server";
  await requireAdmin();
  setSetting("sync_backend", kind === "git" ? "git" : "obsidian");
  return { ok: true };
}

export interface GitSetupResult {
  ok: boolean;
  message?: string;
}

// Link a git repo as the vault. Probes the remote first so a bad URL, a bad
// token, or a too-old git reports precisely instead of failing halfway through
// a clone.
export async function setupGitRepo(
  remote: string,
  branch: string,
  username: string,
  token: string,
): Promise<GitSetupResult> {
  "use server";
  await requireAdmin();
  const url = remote.trim();
  const ref = branch.trim() || "main";
  // HTTPS only: the token travels with every fetch and push, so a plaintext
  // remote would put it on the wire. OB_ALLOW_LOCAL_GIT exists so the project's
  // own tests can point at a bare repo on disk; it is not documented for
  // deployments and does nothing unless explicitly set.
  const allowLocal = process.env.OB_ALLOW_LOCAL_GIT === "1";
  const acceptable = allowLocal
    ? /^(https:\/\/|file:\/\/|\/)[^\s]+$/i.test(url)
    : /^https:\/\/[^\s]+$/i.test(url);
  if (!acceptable) {
    return {
      ok: false,
      message: "Use an HTTPS clone URL (https://…). SSH remotes aren't supported yet.",
    };
  }
  if (!/^[\w.\-\/]+$/.test(ref)) {
    return { ok: false, message: "Branch names are limited to letters, numbers, . - _ and /." };
  }

  storeGitCredentials(username, token);
  const probe = await probeRemote(url, ref);
  if (!probe.ok) {
    clearGitCredentials();
    return { ok: false, message: probe.message ?? "Could not reach the repository." };
  }

  setSetting("git_remote", url);
  setSetting("git_branch", ref);
  const cloned = await cloneVault(url, ref);
  if (!cloned.ok) {
    return { ok: false, message: cloned.message ?? "Clone failed." };
  }

  setSetting("vault_name", repoDisplayName(url));
  setSetting("vault_configured", "true");
  syncBackend().resetAndStart();
  return { ok: true };
}

// Plain server function, deliberately NOT wrapped in solid-router's query():
// query() caches by key, so the wizard's refetch after each step would see the
// stale stage and never advance.
export async function getSetupStage(): Promise<SetupStage> {
  "use server";
  return computeStage();
}

export interface ClaimState {
  claimable: boolean;
  secondsLeft: number;
  windowMinutes: number;
  /**
   * Set when the server was reached at an origin it wasn't configured with.
   * Surfaced here specifically because this is the page where it bites: the
   * auth layer refuses sign-up with "Invalid origin" before there is any
   * account to sign in with, so the warnings on the admin tabs are unreachable.
   */
  originMismatch: OriginMismatch | null;
}

// Public by necessity: this drives the very first screen, before any account
// exists to authenticate against. Once the instance is claimed it reports a
// closed window unconditionally, so it stops describing the process to anyone
// who asks.
export async function getClaimState(): Promise<ClaimState> {
  "use server";
  await runAuthMigrations();
  const mismatch = detectOriginMismatch(
    env.baseUrl,
    getRequestEvent()?.request.headers.get("host"),
  );
  if (await isSetupComplete()) {
    return {
      claimable: false,
      secondsLeft: 0,
      windowMinutes: CLAIM_WINDOW_MINUTES,
      originMismatch: mismatch,
    };
  }
  const remaining = claimWindowRemainingMs();
  return {
    claimable: remaining > 0,
    secondsLeft: Math.ceil(remaining / 1000),
    windowMinutes: CLAIM_WINDOW_MINUTES,
    originMismatch: mismatch,
  };
}

export interface ObsidianLoginResult {
  ok: boolean;
  mfaRequired?: boolean;
  message?: string;
}

// Wizard step: link the Obsidian account. Requires an admin session — the
// admin account is created before this step, so all ob-facing actions are
// behind login.
export async function setupObsidianLogin(
  email: string,
  password: string,
  mfa?: string,
): Promise<ObsidianLoginResult> {
  "use server";
  await requireAdmin();
  const res = await obLogin(email, password, mfa || undefined);
  if (!res.ok) {
    if (looksLikeMfaRequired(res.combined)) {
      return { ok: false, mfaRequired: true, message: "Multi-factor code required." };
    }
    return { ok: false, message: lastLines(res.combined) || "Login failed." };
  }
  // ob exits 0 even when the login did not take, so a zero exit proves nothing.
  // Confirm with a command that genuinely requires auth before recording
  // success — otherwise the wizard advances to the vault picker and only then
  // discovers there is no session, with no way back.
  if (!(await obIsAuthenticated())) {
    if (looksLikeMfaRequired(res.combined)) {
      return { ok: false, mfaRequired: true, message: "Multi-factor code required." };
    }
    // A wrong password fails loudly: the CLI exits non-zero with "Login failed,
    // please double check your email and password". Exiting cleanly with no
    // output at all means something else — in practice, that it prompted for a
    // two-factor code and reached end-of-input, because a server can't answer
    // an interactive prompt.
    if (!res.combined.trim()) {
      return {
        ok: false,
        mfaRequired: true,
        message:
          "The sync client stopped without an error, which almost always means it asked for a " +
          "two-factor code. Enter the current code from your authenticator and try again.",
      };
    }
    return {
      ok: false,
      message:
        lastLines(res.combined) ||
        "Obsidian did not accept those credentials. Check the email and password for your " +
          "Obsidian.md account — these are not your vault's encryption password.",
    };
  }
  storeObsidianAccount(email, password);
  setSetting("obsidian_logged_in", "true");
  return { ok: true };
}

export interface VaultListResult {
  ok: boolean;
  vaults: RemoteVault[];
  raw: string;
  message?: string;
}

export async function setupListVaults(): Promise<VaultListResult> {
  "use server";
  await requireAdmin();
  const { result, vaults } = await obListRemoteVaults();
  if (!result.ok || (!vaults.length && looksLikeAuthFailure(result.combined))) {
    // Losing the session here means the wizard would otherwise sit on a vault
    // picker it can never populate. Drop back to the login step so the
    // credentials can simply be entered again.
    if (looksLikeAuthFailure(result.combined)) {
      setSetting("obsidian_logged_in", "false");
      return {
        ok: false,
        vaults: [],
        raw: result.combined,
        message: "The Obsidian session is gone — sign in again.",
      };
    }
    return { ok: false, vaults: [], raw: result.combined, message: lastLines(result.combined) };
  }
  return { ok: true, vaults, raw: result.stdout };
}

export async function setupConfigureVault(
  vault: string,
  encryptionPassword: string,
): Promise<{ ok: boolean; message?: string }> {
  "use server";
  await requireAdmin();
  const res = await obSyncSetup(vault, encryptionPassword || undefined);
  if (!res.ok) {
    return { ok: false, message: lastLines(res.combined) || "sync-setup failed." };
  }
  if (encryptionPassword) storeVaultPassword(encryptionPassword);
  setSetting("vault_configured", "true");
  // The picker passes the vault id; sync-status --json knows the display name.
  let vaultName = vault;
  const status = await obSyncStatus();
  if (status.ok) {
    try {
      const parsed = JSON.parse(status.stdout);
      if (typeof parsed.vaultName === "string" && parsed.vaultName) vaultName = parsed.vaultName;
    } catch {
      // keep the id as the name
    }
  }
  setSetting("vault_name", vaultName);
  syncBackend().resetAndStart();
  return { ok: true };
}

// Trim CLI output to something presentable in the UI.
function lastLines(s: string, n = 4): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join("\n");
}
