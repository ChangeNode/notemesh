import fs from "node:fs";
import path from "node:path";
import { getRequestEvent } from "solid-js/web";
import { auth, audit, MAX_OAUTH_CLIENTS } from "./auth";
import { authFailureSnapshot } from "./mcp/ratelimit";
import { CLAIM_WINDOW_MINUTES } from "./claim";
import { requireAdmin } from "./session";
import { db, getSetting, setSetting } from "./db";
import { env, detectOriginMismatch } from "./env";
import { MAX_LOG_LINES } from "./ob/supervisor";
import { syncBackend, syncKind } from "./sync";
import { vaultInfo } from "./vault/queries";
import { formatBytes } from "./vault/paths";
import { indexer, ensureIndexerStarted } from "./vault/indexer";
import { obLogin, looksLikeMfaRequired } from "./ob/cli";
import { storeObsidianAccount, getObsidianAccount } from "./ob/credentials";

function headers(): Headers {
  return getRequestEvent()!.request.headers;
}

// Diagnose a server that booted before it had a public domain. The comparison
// itself lives in env.ts so it can be tested without a request context.
function originMismatch() {
  return detectOriginMismatch(env.baseUrl, getRequestEvent()?.request.headers.get("host"));
}

// Plain server functions (no solid-router query()/action() wrappers): each tab
// refetches after every mutation, and query()'s key-based cache would serve
// stale data to those refetches.
//
// One loader per tab rather than one shared dashboard payload, so switching
// tabs doesn't re-run every query — notably vaultInfo(), which counts notes
// and words, and listApiKeys(), which hits Better Auth.

// Clients from unauthenticated dynamic client registration (the MCP norm) have
// no owning user, so Better Auth's session-scoped get-clients endpoint returns
// nothing — query the OAuth tables directly.
function oauthClientRows() {
  return db()
    .prepare('SELECT clientId, name, createdAt FROM "oauthClient" ORDER BY createdAt DESC')
    .all() as { clientId: string; name: string | null; createdAt: string | number }[];
}

// The ob CLI writes its own per-vault sync log under its HOME, which is the
// only log this app puts on disk — everything we emit ourselves goes to
// stdout. Discovered rather than hardcoded: the directory is keyed by remote
// vault id, and there can be more than one if the vault was re-linked.
function syncLogFiles(): { path: string; size: string; modified: number | null }[] {
  const base = path.join(env.obHomeDir, ".obsidian-headless", "sync");
  let entries: string[];
  try {
    entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return []; // nothing synced yet
  }
  const found: { path: string; size: string; modified: number | null }[] = [];
  for (const dir of entries) {
    const file = path.join(base, dir, "sync.log");
    try {
      const st = fs.statSync(file);
      found.push({ path: file, size: formatBytes(st.size), modified: st.mtimeMs });
    } catch {
      // no log in this vault dir
    }
  }
  return found;
}

// Setup tab: how to point an MCP client at this server, plus API keys.
export async function getSetupPage() {
  "use server";
  await requireAdmin();
  ensureIndexerStarted();
  const keys = await auth.api.listApiKeys({ headers: headers() }).catch(() => []);
  return {
    baseUrl: env.baseUrl,
    originMismatch: originMismatch(),
    apiKeys: (Array.isArray(keys) ? keys : ((keys as any)?.apiKeys ?? [])).map((k: any) => ({
      id: k.id,
      name: k.name ?? "(unnamed)",
      createdAt: k.createdAt,
      start: k.start ?? null,
    })),
  };
}

// Status tab: sync health, vault stats, log tail, and the connected clients.
export async function getStatusPage() {
  "use server";
  await requireAdmin();
  ensureIndexerStarted();
  const sup = syncBackend();
  return {
    vault: vaultInfo(),
    sync: sup.status(),
    logs: sup.getLogs().slice(-80),
    oauthClients: oauthClientRows().map((c) => ({
      clientId: c.clientId,
      name: c.name ?? "(unnamed client)",
      createdAt: c.createdAt,
    })),
  };
}

export async function getSettingsPage() {
  "use server";
  await requireAdmin();
  return {
    deleteEnabled: getSetting("delete_enabled") === "true",
    dailyFolder: getSetting("daily_folder") ?? "",
    dailyFormat: getSetting("daily_format") ?? "YYYY-MM-DD",
    syncLogs: syncLogFiles(),
    logTailLines: MAX_LOG_LINES,
    backend: syncKind(),
    gitRemote: getSetting("git_remote") ?? "",
    gitBranch: getSetting("git_branch") ?? "main",
    gitConflictStrategy: getSetting("git_conflict_strategy") ?? "file",
    gitDebounceSeconds: Number(getSetting("git_debounce_seconds")) || 5,
    gitPullSeconds: Number(getSetting("git_pull_seconds")) || 30,
  };
}

// Security tab: the live posture of this instance. Everything here is derived
// from current state rather than documentation, so it stays true as the
// deployment changes (moving behind Railway's proxy, enabling delete, etc).
export async function getSecurityPage() {
  "use server";
  await requireAdmin();
  const d = db();
  const count = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
  const keys = await auth.api.listApiKeys({ headers: headers() }).catch(() => []);
  const keyCount = (Array.isArray(keys) ? keys : ((keys as any)?.apiKeys ?? [])).length;
  const url = env.baseUrl;
  return {
    baseUrl: url,
    isHttps: url.startsWith("https://"),
    isLocalAddress: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url),
    trustsProxyHeaders: Boolean(
      process.env.RAILWAY_PUBLIC_DOMAIN || process.env.TRUST_PROXY_HEADERS,
    ),
    deleteEnabled: getSetting("delete_enabled") === "true",
    apiKeyCount: keyCount,
    oauthClientCount: oauthClientRows().length,
    maxOAuthClients: MAX_OAUTH_CLIENTS,
    consentCount: count('SELECT COUNT(*) AS n FROM "oauthConsent"'),
    accessTokenCount: count('SELECT COUNT(*) AS n FROM "oauthAccessToken"'),
    throttle: authFailureSnapshot(),
    claimWindowMinutes: CLAIM_WINDOW_MINUTES,
    originMismatch: originMismatch(),
    backend: syncKind(),
  };
}

// Lightweight poll target for the live status/logs view — everything here is
// in-memory or a cheap SQLite count, safe to hit every couple of seconds.
export async function getSyncActivity() {
  "use server";
  await requireAdmin();
  const sup = syncBackend();
  return {
    now: Date.now(),
    sync: sup.status(),
    logs: sup.getLogs().slice(-200),
    vault: vaultInfo(),
  };
}

export async function createApiKey(name: string) {
  "use server";
  const session = await requireAdmin();
  audit("apikey.create", { user: session.user.id, name });
  const res = await auth.api.createApiKey({
    body: { name: name || "mcp-client" },
    headers: headers(),
  });
  // The plaintext key is shown exactly once; the caller revalidates the list.
  return { key: (res as any).key as string };
}

export async function deleteApiKey(keyId: string) {
  "use server";
  const session = await requireAdmin();
  audit("apikey.delete", { user: session.user.id, keyId });
  await auth.api.deleteApiKey({ body: { keyId }, headers: headers() });
  return { ok: true };
}

export async function revokeOAuthClient(clientId: string) {
  "use server";
  const session = await requireAdmin();
  audit("oauth.client.revoke", { user: session.user.id, clientId });
  // Remove the client and everything it was granted (tokens + consent), so a
  // revoked connector loses access immediately.
  const d = db();
  d.prepare('DELETE FROM "oauthAccessToken" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthRefreshToken" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthConsent" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthClient" WHERE clientId = ?').run(clientId);
  return { ok: true };
}

// How eagerly the git backend publishes and refreshes. Debounce trades latency
// for commit noise; pull interval trades freshness for API calls.
export async function setGitTiming(debounceSeconds: number, pullSeconds: number) {
  "use server";
  await requireAdmin();
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
  setSetting("git_debounce_seconds", String(clamp(debounceSeconds, 1, 300)));
  setSetting("git_pull_seconds", String(clamp(pullSeconds, 5, 3600)));
  // Timers are read at start(), so restart to pick the new values up.
  syncBackend().resetAndStart();
  return { ok: true };
}

// What to do when git can't reconcile two versions. See sync/conflict.ts —
// this only ever applies to the residue git cannot merge itself.
export async function setGitConflictStrategy(strategy: string) {
  "use server";
  await requireAdmin();
  const valid = strategy === "branch" || strategy === "inline" ? strategy : "file";
  setSetting("git_conflict_strategy", valid);
  return { ok: true };
}

export async function setDeleteEnabled(enabled: boolean) {
  "use server";
  await requireAdmin();
  setSetting("delete_enabled", enabled ? "true" : "false");
  return { ok: true };
}

// Where daily notes live. Needed because the ob daemon doesn't sync the
// .obsidian config folder, so the vault's own daily-notes settings aren't
// visible on the server.
export async function setDailyConfig(folder: string, format: string) {
  "use server";
  await requireAdmin();
  setSetting("daily_folder", folder.trim().replace(/^\/+|\/+$/g, ""));
  setSetting("daily_format", format.trim() || "YYYY-MM-DD");
  return { ok: true };
}

export async function syncNow() {
  "use server";
  await requireAdmin();
  // Each backend reports the outcome into its own log; see supervisor.syncNow
  // and GitBackend.syncNow.
  return syncBackend().syncNow();
}

export async function restartSync() {
  "use server";
  await requireAdmin();
  const sup = syncBackend();
  sup.stop();
  // Give the child a moment to exit before restarting.
  await new Promise((r) => setTimeout(r, 1_000));
  sup.resetAndStart();
  return { ok: true };
}

export async function rebuildIndex() {
  "use server";
  await requireAdmin();
  await indexer().rebuild();
  return { ok: true };
}

// Re-login with stored credentials (or fresh ones if the password changed).
export async function reauth(input: { email?: string; password?: string; mfa?: string }) {
    "use server";
    const session = await requireAdmin();
    audit("obsidian.reauth.attempt", { user: session.user.id });
    let email = input.email;
    let password = input.password;
    if (!email || !password) {
      const stored = getObsidianAccount();
      if (!stored) return { ok: false, message: "No stored credentials — enter them again." };
      email = stored.email;
      password = stored.password;
    }
    const res = await obLogin(email, password, input.mfa || undefined);
    if (!res.ok) {
      return {
        ok: false,
        mfaRequired: looksLikeMfaRequired(res.combined),
        message: res.combined.split("\n").filter(Boolean).slice(-3).join("\n"),
      };
    }
    if (input.email && input.password) storeObsidianAccount(input.email, input.password);
    syncBackend().resetAndStart();
  return { ok: true };
}
