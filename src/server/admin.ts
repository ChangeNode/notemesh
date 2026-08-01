import { getRequestEvent } from "solid-js/web";
import { auth, audit } from "./auth";
import { requireAdmin } from "./session";
import { db, getSetting, setSetting } from "./db";
import { env } from "./env";
import { supervisor } from "./ob/supervisor";
import { vaultInfo } from "./vault/queries";
import { indexer, ensureIndexerStarted } from "./vault/indexer";
import { obLogin, obSyncOnce, looksLikeMfaRequired } from "./ob/cli";
import { storeObsidianAccount, getObsidianAccount } from "./ob/credentials";

function headers(): Headers {
  return getRequestEvent()!.request.headers;
}

// Plain server functions (no solid-router query()/action() wrappers): the
// dashboard refetches after every mutation, and query()'s key-based cache
// would serve stale data to those refetches.
export async function getDashboard() {
  "use server";
  await requireAdmin();
  ensureIndexerStarted();
  const keys = await auth.api.listApiKeys({ headers: headers() }).catch(() => []);
  // Query OAuth tables directly: clients from unauthenticated dynamic client
  // registration (the MCP norm) have no owning user, so the session-scoped
  // get-clients endpoint would return nothing.
  const clients = db()
    .prepare('SELECT clientId, name, createdAt FROM "oauthClient" ORDER BY createdAt DESC')
    .all() as { clientId: string; name: string | null; createdAt: string | number }[];
  const consents = db().prepare('SELECT COUNT(*) AS n FROM "oauthConsent"').get() as { n: number };
  const sup = supervisor();
  return {
    baseUrl: env.baseUrl,
    vault: vaultInfo(),
    sync: sup.status(),
    logs: sup.getLogs().slice(-80),
    deleteEnabled: getSetting("delete_enabled") === "true",
    dailyFolder: getSetting("daily_folder") ?? "",
    dailyFormat: getSetting("daily_format") ?? "YYYY-MM-DD",
    apiKeys: (Array.isArray(keys) ? keys : ((keys as any)?.apiKeys ?? [])).map((k: any) => ({
      id: k.id,
      name: k.name ?? "(unnamed)",
      createdAt: k.createdAt,
      start: k.start ?? null,
    })),
    oauthClients: clients.map((c) => ({
      clientId: c.clientId,
      name: c.name ?? "(unnamed client)",
      createdAt: c.createdAt,
    })),
    consentCount: consents.n,
  };
}

// Lightweight poll target for the live status/logs view — everything here is
// in-memory or a cheap SQLite count, safe to hit every couple of seconds.
export async function getSyncActivity() {
  "use server";
  await requireAdmin();
  const sup = supervisor();
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
  const res = await obSyncOnce();
  return { ok: res.ok, output: res.combined.split("\n").slice(-5).join("\n") };
}

export async function restartSync() {
  "use server";
  await requireAdmin();
  const sup = supervisor();
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
    supervisor().resetAndStart();
  return { ok: true };
}
