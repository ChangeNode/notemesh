import { createSignal, createResource, Show, For, Match, Switch } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import {
  getSetupStage,
  setupObsidianLogin,
  setupListVaults,
  setupConfigureVault,
  type SetupStage,
} from "~/server/setup";

const STEP_NUMBER: Record<SetupStage, number> = {
  admin: 1,
  "obsidian-login": 2,
  vault: 3,
  done: 3,
};

export default function Setup() {
  const [stage, { refetch }] = createResource<SetupStage>(() => getSetupStage());
  const navigate = useNavigate();

  return (
    <main class="container">
      <hgroup>
        <h2>Set up your Obsidian MCP server</h2>
        <Show when={stage() && stage() !== "done"}>
          <p class="muted">Step {STEP_NUMBER[stage()!]} of 3</p>
        </Show>
      </hgroup>
      <Show when={stage() && stage() !== "done"}>
        <progress value={STEP_NUMBER[stage()!] - 1} max={3} />
      </Show>
      <Show when={stage()} keyed>
        {(s) => (
          <Switch>
            <Match when={s === "admin"}>
              <AdminStep onDone={refetch} />
            </Match>
            <Match when={s === "obsidian-login"}>
              <ObsidianStep onDone={refetch} />
            </Match>
            <Match when={s === "vault"}>
              <VaultStep onDone={refetch} />
            </Match>
            <Match when={s === "done"}>
              <article>
                <header>
                  <strong>✅ Setup complete</strong>
                </header>
                <p>Your vault is syncing and the MCP endpoint is live.</p>
                <button onClick={() => navigate("/")}>Go to dashboard</button>
              </article>
            </Match>
          </Switch>
        )}
      </Show>
    </main>
  );
}

function AdminStep(props: { onDone: () => void }) {
  const [token, setToken] = createSignal("");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    if (password() !== confirm()) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    const { error } = await authClient.signUp.email({
      email: email(),
      password: password(),
      name: "Admin",
      fetchOptions: {
        headers: { "x-setup-token": token() },
      },
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Could not create the admin account.");
      return;
    }
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>Claim this server</strong>
      </header>
      <p class="muted">
        Paste the <code>SETUP_TOKEN</code> from your Railway service's Variables tab, then choose
        the admin credentials you'll use to sign in here.
      </p>
      <form onSubmit={submit}>
        <label for="token">Setup token</label>
        <input id="token" type="password" required value={token()} onInput={(e) => setToken(e.currentTarget.value)} />
        <label for="email">Admin email</label>
        <input id="email" type="email" autocomplete="username" required value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
        <div class="grid">
          <div>
            <label for="password">Admin password (10+ characters)</label>
            <input id="password" type="password" autocomplete="new-password" required minLength={10} value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
          </div>
          <div>
            <label for="confirm">Confirm password</label>
            <input id="confirm" type="password" autocomplete="new-password" required value={confirm()} onInput={(e) => setConfirm(e.currentTarget.value)} />
          </div>
        </div>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button type="submit" aria-busy={busy()} disabled={busy()}>
          Create admin account
        </button>
      </form>
    </article>
  );
}

function ObsidianStep(props: { onDone: () => void }) {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [mfa, setMfa] = createSignal("");
  const [mfaRequired, setMfaRequired] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await setupObsidianLogin(email(), password(), mfa() || undefined);
    setBusy(false);
    if (!res.ok) {
      if (res.mfaRequired) setMfaRequired(true);
      setError(res.message ?? "Login failed.");
      return;
    }
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>Link your Obsidian account</strong>
      </header>
      <p class="muted">
        These are your <b>Obsidian.md account</b> credentials (the ones with the Obsidian Sync
        subscription). They're stored encrypted on this server so sync can re-authenticate when the
        session expires.
      </p>
      <form onSubmit={submit}>
        <label for="ob-email">Obsidian account email</label>
        <input id="ob-email" type="email" required value={email()} onInput={(e) => setEmail(e.currentTarget.value)} />
        <label for="ob-password">Obsidian account password</label>
        <input id="ob-password" type="password" required value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        <Show when={mfaRequired()}>
          <label for="ob-mfa">Two-factor code</label>
          <input id="ob-mfa" type="text" inputmode="numeric" value={mfa()} onInput={(e) => setMfa(e.currentTarget.value)} />
        </Show>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button type="submit" aria-busy={busy()} disabled={busy()}>
          Sign in to Obsidian
        </button>
      </form>
    </article>
  );
}

function VaultStep(props: { onDone: () => void }) {
  const [list, { refetch }] = createResource(() => setupListVaults());
  const [vault, setVault] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await setupConfigureVault(vault(), password());
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "Vault setup failed.");
      return;
    }
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>Choose a vault</strong>
      </header>
      <form onSubmit={submit}>
        {/* Status row: fetch state + refresh, separate from the picker. */}
        <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem">
          <Show
            when={!list.loading}
            fallback={<span aria-busy="true">Fetching your remote vaults…</span>}
          >
            <span class="muted">
              {list()?.ok
                ? `Found ${list()!.vaults.length} vault${list()!.vaults.length === 1 ? "" : "s"} in your Obsidian Sync account.`
                : "Couldn't fetch the vault list."}
            </span>
          </Show>
          <button
            type="button"
            class="secondary outline"
            style="margin:0; padding:0.25rem 0.75rem; font-size:0.85em; white-space:nowrap"
            disabled={list.loading}
            onClick={() => {
              setVault("");
              refetch();
            }}
          >
            Refresh
          </button>
        </div>
        <Show when={!list.loading && list()} keyed>
          {(l) => (
            <Show
              when={l.ok && l.vaults.length > 0}
              fallback={
                <>
                  <p class="muted">
                    Enter the vault name exactly as it appears in Obsidian Sync.
                    <Show when={l.raw || l.message}> Raw output:</Show>
                  </p>
                  <Show when={l.raw || l.message}>
                    <pre>{l.raw || l.message}</pre>
                  </Show>
                  <label for="vault-name">Vault name</label>
                  <input id="vault-name" type="text" required value={vault()} onInput={(e) => setVault(e.currentTarget.value)} />
                </>
              }
            >
              <label for="vault-select">Remote vault</label>
              <select
                id="vault-select"
                required
                value={vault()}
                onInput={(e) => setVault(e.currentTarget.value)}
              >
                <option value="" disabled selected={vault() === ""}>
                  Select a vault…
                </option>
                <For each={l.vaults}>
                  {(v) => (
                    <option value={v.id ?? v.name}>
                      {v.name}
                      {v.region ? ` — ${v.region}` : ""}
                    </option>
                  )}
                </For>
              </select>
            </Show>
          )}
        </Show>
        <label for="vault-password">Vault encryption password</label>
        <input id="vault-password" type="password" required value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        <small class="muted">
          The end-to-end encryption password for this vault (set when the vault was created in
          Obsidian Sync). Stored encrypted on this server.
        </small>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button type="submit" aria-busy={busy()} disabled={busy()}>
          {busy() ? "Connecting… (first sync may take a while)" : "Connect vault & start sync"}
        </button>
      </form>
    </article>
  );
}
