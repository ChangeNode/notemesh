import { execa } from "execa";
import { env } from "../env";
import { getGitCredentials } from "./git-credentials";

// Every git invocation goes through here. Split out from git.ts so the
// conflict-resolution module can run git without importing the backend that
// consumes it.

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  combined: string;
  code: number | null;
}

// Credentials reach git through a helper that reads them from the environment
// rather than from argv or the stored remote URL. argv is world-readable via
// ps/proc, and a token baked into the remote would persist in .git/config.
const CREDENTIAL_HELPER =
  `!f() { printf 'username=%s\\npassword=%s\\n' "$OB_GIT_USER" "$OB_GIT_TOKEN"; }; f`;

function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("«redacted»");
  }
  return out;
}

export async function runGit(
  args: string[],
  opts: { cwd?: string; authenticated?: boolean; timeoutMs?: number } = {},
): Promise<GitResult> {
  const creds = opts.authenticated ? getGitCredentials() : null;
  const full = creds ? ["-c", `credential.helper=${CREDENTIAL_HELPER}`, ...args] : args;
  try {
    const res = await execa("git", full, {
      cwd: opts.cwd ?? env.vaultDir,
      env: {
        // Never prompt: an interactive credential prompt in a daemon hangs
        // forever instead of failing.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        ...(creds ? { OB_GIT_USER: creds.username, OB_GIT_TOKEN: creds.token } : {}),
      },
      timeout: opts.timeoutMs ?? 120_000,
      reject: false,
      all: true,
    });
    const secrets = [creds?.token];
    return {
      ok: res.exitCode === 0,
      stdout: redact(String(res.stdout ?? ""), secrets),
      stderr: redact(String(res.stderr ?? ""), secrets),
      combined: redact(String((res as any).all ?? ""), secrets),
      code: res.exitCode ?? null,
    };
  } catch (e: any) {
    const msg = redact(String(e?.message ?? e), [getGitCredentials()?.token]);
    return { ok: false, stdout: "", stderr: msg, combined: msg, code: null };
  }
}


// Binary-safe variant: `git show` on an attachment must not be forced through
// UTF-8 decoding, or a conflict copy of an image would be written as mojibake.
export async function runGitBuffer(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: Buffer }> {
  try {
    const res = await execa("git", args, {
      cwd: opts.cwd ?? env.vaultDir,
      env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
      timeout: opts.timeoutMs ?? 120_000,
      reject: false,
      encoding: "buffer",
    });
    // execa hands back a Uint8Array here. Convert rather than cast: the two are
    // interchangeable for fs writes, but only a Buffer has an encoding-aware
    // toString, so a cast would leave a trap for the next caller.
    const out = res.stdout as unknown as Uint8Array | undefined;
    return { ok: res.exitCode === 0, stdout: out ? Buffer.from(out) : Buffer.alloc(0) };
  } catch {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
}
