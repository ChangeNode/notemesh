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
  // Which decision is in flight, so the spinner lands on the button that was
  // actually pressed rather than always on Approve.
  const [pending, setPending] = createSignal<"approve" | "deny" | null>(null);
  const busy = () => pending() !== null;

  async function decide(accept: boolean) {
    // Belt and braces alongside the disabled attribute: a second click
    // dispatched before the re-render must not start a second grant.
    if (busy()) return;
    setPending(accept ? "approve" : "deny");
    setError(null);
    const { data, error } = await (authClient as any).oauth2.consent({ accept });
    if (error) {
      // Only re-enable when we are staying on this page.
      setPending(null);
      setError(error.message ?? "Something went wrong.");
      return;
    }
    if (data?.url) {
      // Deliberately stay busy. Assigning location starts a navigation but does
      // not stop this page rendering or responding, so clearing the flag here
      // would leave both buttons live for as long as the redirect takes — long
      // enough that a user who sees nothing happen clicks Approve again and
      // submits a second consent for an already-granted request.
      window.location.href = data.url;
      return;
    }
    setPending(null);
    setError("The server did not return a redirect. Try again.");
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
            <button
              aria-busy={pending() === "approve"}
              disabled={busy()}
              onClick={() => decide(true)}
            >
              {pending() === "approve" ? "Authorizing…" : "Approve"}
            </button>
            <button
              class="secondary"
              aria-busy={pending() === "deny"}
              disabled={busy()}
              onClick={() => decide(false)}
            >
              Deny
            </button>
          </div>
        </footer>
      </article>
      <RepoFooter />
    </main>
  );
}
