import {
  createSignal,
  createResource,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
  Match,
  Switch,
} from "solid-js";
import { useNavigate } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import {
  getSetupStage,
  setupObsidianLogin,
  setupListVaults,
  setupConfigureVault,
  getClaimState,
  type SetupStage,
} from "~/server/setup";
import { RepoFooter } from "~/components/AdminShell";

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
        <h2>Set up ob-sync</h2>
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
                <button onClick={() => navigate("/")}>Go to Dashboard</button>
              </article>
            </Match>
          </Switch>
        )}
      </Show>
      <RepoFooter />
    </main>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m <= 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function AdminStep(props: { onDone: () => void }) {
  const [claim] = createResource(() => getClaimState());
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Count the window down locally from the server's figure so the page turns
  // itself over to the lockdown notice at zero, rather than letting someone
  // fill in a form that the server will refuse.
  //
  // Derived from a plain elapsed counter rather than seeded into a signal by an
  // effect: effects don't run during SSR, so a seeded signal would still be at
  // its initial value when the server renders and every fresh instance would
  // render as locked down.
  const [elapsed, setElapsed] = createSignal(0);
  onMount(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  const left = () => Math.max(0, (claim()?.secondsLeft ?? 0) - elapsed());
  const open = () => Boolean(claim()?.claimable) && left() > 0;

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
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Could not create the admin account.");
      return;
    }
    props.onDone();
  }

  return (
    <Show when={claim()} keyed>
      {(c) => (
        <Show
          when={open()}
          fallback={
            <article>
              <header>
                <strong>🔒 Locked down</strong>
              </header>
              <p>
                This server wasn't claimed within {c.windowMinutes} minutes of starting, so it
                stopped accepting new admin accounts.
              </p>
              <p class="muted">
                Restart the server and open this page again — you'll have another{" "}
                {c.windowMinutes} minutes to create the account. On Railway that's your service →{" "}
                <b>Deployments</b> → <b>Restart</b>.
              </p>
            </article>
          }
        >
          <article>
            <header>
              <strong>Claim this server</strong>
            </header>
            <p class="muted">
              Nobody has claimed this server yet, so you can create the admin account now — no
              token needed. For safety this is only possible in the first {c.windowMinutes} minutes
              after the server starts.
            </p>
            <p>
              <b>Time remaining: {formatCountdown(left())}</b>
            </p>
            <form onSubmit={submit}>
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
                Create Admin Account
              </button>
            </form>
          </article>
        </Show>
      )}
    </Show>
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
          Sign In to Obsidian
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

  // Once the list arrives, select the first vault so the dropdown needs no
  // placeholder option (most accounts have exactly one vault anyway).
  createEffect(() => {
    const l = list();
    if (l?.ok && l.vaults.length > 0 && !vault()) {
      setVault(l.vaults[0].id ?? l.vaults[0].name);
    }
  });

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
                <For each={l.vaults}>
                  {(v) => (
                    <option value={v.id ?? v.name} selected={vault() === (v.id ?? v.name)}>
                      {v.name}
                      {v.region ? ` — ${v.region}` : ""}
                    </option>
                  )}
                </For>
              </select>
            </Show>
          )}
        </Show>
        <label for="vault-password">Vault encryption password (only for end-to-end encrypted vaults)</label>
        <input id="vault-password" type="password" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        <small class="muted">
          Leave this blank if your vault uses managed encryption (the default — no password was set
          when the vault was created). Only end-to-end encrypted vaults have a password; if yours
          does, it's stored encrypted on this server.
        </small>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button type="submit" aria-busy={busy()} disabled={busy()}>
          {busy() ? "Connecting… (first sync may take a while)" : "Connect Vault & Start Sync"}
        </button>
      </form>
    </article>
  );
}
