import { query, action, reload } from "@solidjs/router";
import { getRequestEvent } from "solid-js/web";
import { auth } from "./auth";
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

export const getDashboard = query(async () => {
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
}, "dashboard");

export const createApiKeyAction = action(async (name: string) => {
  "use server";
  await requireAdmin();
  const res = await auth.api.createApiKey({
    body: { name: name || "mcp-client" },
    headers: headers(),
  });
  // The plaintext key is shown exactly once; the caller revalidates the list.
  return { key: (res as any).key as string };
});

export const deleteApiKeyAction = action(async (keyId: string) => {
  "use server";
  await requireAdmin();
  await auth.api.deleteApiKey({ body: { keyId }, headers: headers() });
  return reload({ revalidate: [getDashboard.key] });
});

export const revokeOAuthClientAction = action(async (clientId: string) => {
  "use server";
  await requireAdmin();
  // Remove the client and everything it was granted (tokens + consent), so a
  // revoked connector loses access immediately.
  const d = db();
  d.prepare('DELETE FROM "oauthAccessToken" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthRefreshToken" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthConsent" WHERE clientId = ?').run(clientId);
  d.prepare('DELETE FROM "oauthClient" WHERE clientId = ?').run(clientId);
  return reload({ revalidate: [getDashboard.key] });
});

export const setDeleteEnabledAction = action(async (enabled: boolean) => {
  "use server";
  await requireAdmin();
  setSetting("delete_enabled", enabled ? "true" : "false");
  return reload({ revalidate: [getDashboard.key] });
});

export const syncNowAction = action(async () => {
  "use server";
  await requireAdmin();
  const res = await obSyncOnce();
  return { ok: res.ok, output: res.combined.split("\n").slice(-5).join("\n") };
});

export const restartSyncAction = action(async () => {
  "use server";
  await requireAdmin();
  const sup = supervisor();
  sup.stop();
  // Give the child a moment to exit before restarting.
  await new Promise((r) => setTimeout(r, 1_000));
  sup.resetAndStart();
  return reload({ revalidate: [getDashboard.key] });
});

export const rebuildIndexAction = action(async () => {
  "use server";
  await requireAdmin();
  indexer().rebuild();
  return reload({ revalidate: [getDashboard.key] });
});

// Re-login with stored credentials (or fresh ones if the password changed).
export const reauthAction = action(
  async (input: { email?: string; password?: string; mfa?: string }) => {
    "use server";
    await requireAdmin();
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
  },
);
