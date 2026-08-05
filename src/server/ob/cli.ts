import { execa, type Result } from "execa";
import fs from "node:fs";
import path from "node:path";
import { env, ensureDataDirs } from "../env";

// Resolve the ob binary: explicit override, then PATH (Docker installs it
// globally), then the local node_modules/.bin (dev).
function obBin(): string {
  if (process.env.OB_BIN) return process.env.OB_BIN;
  const local = path.resolve("node_modules/.bin/ob");
  if (fs.existsSync(local)) return local;
  return "ob";
}

export interface ObResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
}

// Reject values that could be misread as flags by the ob argument parser, or
// that carry control characters. Used for the untrusted vault identifier and
// for credential values that are passed as flags.
export class ObArgError extends Error {}
export function assertSafeArg(value: string, label: string) {
  if (value.startsWith("-")) throw new ObArgError(`${label} may not start with "-"`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) throw new ObArgError(`${label} contains control characters`);
}

// Redact known secret substrings from CLI output before it is logged or shown.
// execa never passes these through a shell, but ob could echo an argument on an
// error path; scrub defensively.
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 3) out = out.split(s).join("«redacted»");
  }
  return out;
}

// The ob CLI is driven non-interactively. By default stdin is closed so an
// unexpected prompt fails fast; when `stdinInput` is given (a single secret),
// it's written to stdin so ob can consume it via its "prompted if omitted"
// path instead of receiving the secret on argv (which is world-readable via
// /proc and ps). `redactSecrets` are scrubbed from all captured output.
export async function runOb(
  args: string[],
  opts: { timeoutMs?: number; stdinInput?: string; redactSecrets?: (string | undefined)[] } = {},
): Promise<ObResult> {
  ensureDataDirs();
  let res: Result;
  try {
    res = await execa(obBin(), args, {
      env: { HOME: env.obHomeDir },
      cwd: env.dataDir,
      input: opts.stdinInput,
      stdin: opts.stdinInput === undefined ? "ignore" : "pipe",
      timeout: opts.timeoutMs ?? 60_000,
      reject: false,
      all: true,
    });
  } catch (e: any) {
    const msg = redact(String(e?.message ?? e), opts.redactSecrets ?? []);
    return { ok: false, stdout: "", stderr: msg, combined: msg };
  }
  const stdout = redact(String(res.stdout ?? ""), opts.redactSecrets ?? []);
  const stderr = redact(String(res.stderr ?? ""), opts.redactSecrets ?? []);
  return {
    ok: res.exitCode === 0,
    stdout,
    stderr,
    combined: redact(
      String((res as any).all ?? [stdout, stderr].filter(Boolean).join("\n")),
      opts.redactSecrets ?? [],
    ),
  };
}

export function looksLikeMfaRequired(output: string): boolean {
  return /\b(mfa|2fa|two.?factor|verification code|one.?time)\b/i.test(output);
}

export function looksLikeAuthFailure(output: string): boolean {
  return /\b(unauthorized|not logged in|no account logged in|login required|login failed|invalid (email|password|credentials)|session expired|forbidden|401)\b/i.test(
    output,
  );
}

export async function obLogin(email: string, password: string, mfa?: string): Promise<ObResult> {
  assertSafeArg(email, "Email");
  if (mfa) assertSafeArg(mfa, "MFA code");
  // Password goes via stdin (ob prompts for it when --password is omitted), so
  // the durable secret never appears in argv. Email + MFA (ephemeral) stay as
  // flags; ob then only needs the single stdin value for the password prompt.
  const args = ["login", "--email", email];
  if (mfa) args.push("--mfa", mfa);
  return runOb(args, { timeoutMs: 90_000, stdinInput: password + "\n", redactSecrets: [password, mfa] });
}

// `ob login` with no flags reports current login status.
export async function obLoginStatus(): Promise<ObResult> {
  return runOb(["login"], { timeoutMs: 30_000 });
}

// Reliable authentication probe. ob returns exit code 0 even when logged out,
// so we can't trust the exit code — instead run a command that genuinely needs
// auth (sync-list-remote) and inspect its output. Returns true only when it
// clearly succeeds (parses to a vaults array). This is an ob-issued command, so
// its "no account logged in" message can't be spoofed by a synced filename.
export async function obIsAuthenticated(): Promise<boolean> {
  const res = await runOb(["sync-list-remote", "--json"], { timeoutMs: 30_000 });
  if (/no account logged in|not logged in|log ?in first/i.test(res.combined)) return false;
  try {
    const data = JSON.parse(res.stdout);
    return Array.isArray(data.vaults);
  } catch {
    // Couldn't confirm a good response — treat as not authenticated so the
    // dashboard prompts for re-auth rather than looping in backoff.
    return false;
  }
}

export interface RemoteVault {
  id?: string;
  name: string;
  region?: string;
  raw: string;
}

// ob >= 0.0.14: --json gives { vaults: [{id, name, region}], shared: [...] }.
// The text parser stays as a fallback in case the JSON shape changes.
export async function obListRemoteVaults(): Promise<{ result: ObResult; vaults: RemoteVault[] }> {
  const result = await runOb(["sync-list-remote", "--json"], { timeoutMs: 60_000 });
  if (!result.ok) return { result, vaults: [] };
  try {
    const data = JSON.parse(result.stdout);
    const entries = [...(data.vaults ?? []), ...(data.shared ?? [])];
    return {
      result,
      vaults: entries.map((v: any) => ({
        id: typeof v.id === "string" ? v.id : undefined,
        name: String(v.name ?? v.id ?? "(unnamed vault)"),
        region: typeof v.region === "string" ? v.region : undefined,
        raw: JSON.stringify(v),
      })),
    };
  } catch {
    return { result, vaults: parseVaultListText(result.stdout) };
  }
}

// Fallback for pre-JSON output: status lines then '"Name" (Region)' entries.
export function parseVaultListText(stdout: string): RemoteVault[] {
  const vaults: RemoteVault[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(fetching|listing|loading|vaults?:|[-=+|]+$)/i.test(trimmed)) continue;
    const quoted = trimmed.match(/^"([^"]+)"\s*\(([^)]+)\)\s*$/);
    if (quoted) {
      vaults.push({ name: quoted[1], region: quoted[2], raw: trimmed });
    } else {
      vaults.push({ name: trimmed.replace(/^[-*"]\s*/, "").replace(/"$/, ""), raw: trimmed });
    }
  }
  return vaults;
}

// Password applies only to end-to-end encrypted vaults; managed-encryption
// vaults (the current default) link without one. `vault` is an id/name that
// originated from parsed ob JSON — validate it can't be read as a flag.
export async function obSyncSetup(vault: string, encryptionPassword?: string): Promise<ObResult> {
  assertSafeArg(vault, "Vault");
  const args = ["sync-setup", "--vault", vault, "--path", env.vaultDir, "--device-name", "notemesh"];
  // E2E password via stdin (ob prompts when --password omitted) so it stays
  // out of argv.
  const stdinInput = encryptionPassword ? encryptionPassword + "\n" : undefined;
  return runOb(args, { timeoutMs: 120_000, stdinInput, redactSecrets: [encryptionPassword] });
}

export async function obSyncStatus(): Promise<ObResult> {
  return runOb(["sync-status", "--path", env.vaultDir, "--json"], { timeoutMs: 30_000 });
}

/**
 * Has `ob sync-setup` been run for this vault?
 *
 * Measured rather than inferred from the daemon's output: on an unconfigured
 * vault `sync-status --json` prints "No sync configuration found for …" as
 * plain text and **exits 0**, so neither the exit code nor a successful run
 * means anything. A parseable JSON body does.
 *
 * Worth the extra command because the alternative is scraping the sync log,
 * and log lines carry synced filenames — the same reason authentication is
 * checked by running a command rather than reading output.
 */
export async function obSyncConfigured(): Promise<boolean> {
  const res = await obSyncStatus();
  // Positive evidence only. "Not configured" is acted on — it stops the daemon
  // and sends the operator back to the wizard — so it must not be concluded
  // from a command that simply failed. A missing binary, a timeout or any
  // other error produces output that is neither the no-config sentence nor
  // JSON, and reading that as "unlinked" would unlink a working vault.
  if (/no sync configuration found|run ['"]?ob sync-setup/i.test(res.combined)) return false;
  if (!res.ok) return true;
  try {
    const data = JSON.parse(res.stdout);
    return typeof data === "object" && data !== null;
  } catch {
    return true;
  }
}

export async function obSyncOnce(): Promise<ObResult> {
  return runOb(["sync", "--path", env.vaultDir], { timeoutMs: 600_000 });
}
