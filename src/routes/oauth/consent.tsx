import { createSignal, createResource, Show, For } from "solid-js";
import { isServer } from "solid-js/web";
import { useSearchParams } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import { RepoFooter } from "~/components/AdminShell";

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  "vault:read": "Read your notes: search, list, and open any note in the vault",
  "vault:write": "Edit your vault: create, modify, and organize notes",
  openid: "Confirm your identity",
  profile: "See your basic profile",
  email: "See your email address",
  offline_access: "Stay connected without re-approving (refresh tokens)",
};

export default function Consent() {
  const [params] = useSearchParams();
  const clientId = () => (typeof params.client_id === "string" ? params.client_id : null);
  const scopes = () =>
    (typeof params.scope === "string" ? params.scope : "").split(" ").filter(Boolean);

  const [client] = createResource(clientId, async (id) => {
    if (isServer) return null;
    try {
      const res = await fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        name: (data.client_name ?? data.name) as string | undefined,
        uri: (data.client_uri ?? data.uri) as string | undefined,
      };
    } catch {
      return null;
    }
  });

  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    const { data, error } = await (authClient as any).oauth2.consent({ accept });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Something went wrong.");
      return;
    }
    if (data?.url) window.location.href = data.url;
  }

  return (
    <main class="container">
      <article>
        <header>
          <strong>Authorize access</strong>
        </header>
        <p>
          <b>{client()?.name ?? clientId() ?? "An application"}</b> is asking to connect to your
          Obsidian vault.
        </p>
        <Show when={client()?.uri}>
          <p class="muted">{client()!.uri}</p>
        </Show>
        <p>It will be able to:</p>
        <ul>
          <For each={scopes()}>{(s) => <li>{SCOPE_DESCRIPTIONS[s] ?? s}</li>}</For>
        </ul>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <footer>
          <div role="group">
            <button aria-busy={busy()} disabled={busy()} onClick={() => decide(true)}>
              Approve
            </button>
            <button class="secondary" disabled={busy()} onClick={() => decide(false)}>
              Deny
            </button>
          </div>
        </footer>
      </article>
      <RepoFooter />
    </main>
  );
}
