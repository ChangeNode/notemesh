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

// The ob CLI (open beta, no --json mode) is driven non-interactively: stdin is
// closed so any interactive prompt fails fast instead of hanging, and callers
// parse the text output tolerantly.
export async function runOb(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ObResult> {
  ensureDataDirs();
  let res: Result;
  try {
    res = await execa(obBin(), args, {
      env: { HOME: env.obHomeDir },
      cwd: env.dataDir,
      stdin: "ignore",
      timeout: opts.timeoutMs ?? 60_000,
      reject: false,
      all: true,
    });
  } catch (e: any) {
    return { ok: false, stdout: "", stderr: String(e?.message ?? e), combined: String(e?.message ?? e) };
  }
  const stdout = String(res.stdout ?? "");
  const stderr = String(res.stderr ?? "");
  return {
    ok: res.exitCode === 0,
    stdout,
    stderr,
    combined: String((res as any).all ?? [stdout, stderr].filter(Boolean).join("\n")),
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
  const args = ["login", "--email", email, "--password", password];
  if (mfa) args.push("--mfa", mfa);
  return runOb(args, { timeoutMs: 90_000 });
}

// `ob login` with no flags reports current login status.
export async function obLoginStatus(): Promise<ObResult> {
  return runOb(["login"], { timeoutMs: 30_000 });
}

export interface RemoteVault {
  id?: string;
  name: string;
  raw: string;
}

export async function obListRemoteVaults(): Promise<{ result: ObResult; vaults: RemoteVault[] }> {
  const result = await runOb(["sync-list-remote"], { timeoutMs: 60_000 });
  const vaults: RemoteVault[] = [];
  if (result.ok) {
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip obvious header/divider lines.
      if (/^([-=+|\s]+|id\s+name.*|name\s+id.*)$/i.test(trimmed)) continue;
      // Common shapes: "<id> <name>", "- name (id)", or just a name.
      const idName = trimmed.match(/^([0-9a-f]{8,})\s+(.+)$/i);
      const nameParen = trimmed.match(/^[-*]?\s*(.+?)\s*\(([0-9a-f]{8,})\)$/i);
      if (idName) {
        vaults.push({ id: idName[1], name: idName[2].trim(), raw: trimmed });
      } else if (nameParen) {
        vaults.push({ id: nameParen[2], name: nameParen[1].trim(), raw: trimmed });
      } else {
        vaults.push({ name: trimmed.replace(/^[-*]\s*/, ""), raw: trimmed });
      }
    }
  }
  return { result, vaults };
}

export async function obSyncSetup(vault: string, encryptionPassword: string): Promise<ObResult> {
  return runOb(
    [
      "sync-setup",
      "--vault",
      vault,
      "--path",
      env.vaultDir,
      "--password",
      encryptionPassword,
      "--device-name",
      "obsidian-mcp-server",
    ],
    { timeoutMs: 120_000 },
  );
}

export async function obSyncStatus(): Promise<ObResult> {
  return runOb(["sync-status", "--path", env.vaultDir], { timeoutMs: 30_000 });
}

export async function obSyncOnce(): Promise<ObResult> {
  return runOb(["sync", "--path", env.vaultDir], { timeoutMs: 600_000 });
}
