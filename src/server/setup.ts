import { getSetting, setSetting } from "./db";
import { isSetupComplete, runAuthMigrations } from "./auth";
import {
  obLogin,
  obListRemoteVaults,
  obSyncSetup,
  looksLikeMfaRequired,
  type RemoteVault,
} from "./ob/cli";
import { storeObsidianAccount, storeVaultPassword } from "./ob/credentials";
import { supervisor } from "./ob/supervisor";
import { requireAdmin } from "./session";

export type SetupStage =
  | "admin" // no admin account yet — wizard step 1
  | "obsidian-login" // admin exists, Obsidian account not linked
  | "vault" // logged in to Obsidian, vault not chosen
  | "done";

async function computeStage(): Promise<SetupStage> {
  await runAuthMigrations();
  if (!(await isSetupComplete())) return "admin";
  if (getSetting("obsidian_logged_in") !== "true") return "obsidian-login";
  if (getSetting("vault_configured") !== "true") return "vault";
  return "done";
}

// Plain server function, deliberately NOT wrapped in solid-router's query():
// query() caches by key, so the wizard's refetch after each step would see the
// stale stage and never advance.
export async function getSetupStage(): Promise<SetupStage> {
  "use server";
  return computeStage();
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
  if (!result.ok) {
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
  setSetting("vault_name", vault);
  supervisor().resetAndStart();
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
