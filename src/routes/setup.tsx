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
import { setTimezone } from "~/server/admin";
import {
  getSetupProgress,
  setupObsidianLogin,
  setupListVaults,
  setupConfigureVault,
  getClaimState,
  setupChooseBackend,
  setupGitRepo,
  type SetupStage,
} from "~/server/setup";
import { RepoFooter } from "~/components/AdminShell";

// Claim, choose, configure, then set the timezone. The Obsidian path splits
// "configure" into login + vault picker, so it runs one step longer than git.
// Before a backend is chosen the longer path is assumed, which is why the total
// can tick down rather than up.
function stepsFor(backend: "obsidian" | "git" | null): SetupStage[] {
  return backend === "git"
    ? ["admin", "backend", "git", "timezone"]
    : ["admin", "backend", "obsidian-login", "vault", "timezone"];
}

export default function Setup() {
  const [progress, { refetch }] = createResource(() => getSetupProgress());
  const navigate = useNavigate();

  const stage = () => progress()?.stage;
  const steps = () => stepsFor(progress()?.backend ?? null);
  const stepNumber = () => steps().indexOf(stage()!) + 1;

  return (
    <main class="container">
      <hgroup>
        <h2>Set up notemesh</h2>
        <Show when={stage() && stage() !== "done"}>
          <p class="muted">
            Step {stepNumber()} of {steps().length}
          </p>
        </Show>
      </hgroup>
      <Show when={stage() && stage() !== "done"}>
        <progress value={stepNumber() - 1} max={steps().length} />
      </Show>
      <Show when={stage()} keyed>
        {(s) => (
          <Switch>
            <Match when={s === "admin"}>
              <AdminStep onDone={refetch} />
            </Match>
            <Match when={s === "backend"}>
              <BackendStep onDone={refetch} />
            </Match>
            <Match when={s === "git"}>
              <GitStep onDone={refetch} />
            </Match>
            <Match when={s === "obsidian-login"}>
              <ObsidianStep onDone={refetch} />
            </Match>
            <Match when={s === "vault"}>
              <VaultStep onDone={refetch} />
            </Match>
            <Match when={s === "timezone"}>
              <TimezoneStep onDone={refetch} />
            </Match>
            <Match when={s === "done"}>
              <article>
                <header>
                  <strong>Setup complete</strong>
                </header>
                <p>Your vault is syncing and the MCP endpoint is live.</p>
                <button onClick={() => navigate("/")}>Go to Dashboard</button>
              </article>

              {/* Last thing on the way out, because it is the one piece of
                  upkeep that lives outside this app and nothing here can do for
                  the operator. Led with what happens if the disk is lost —
                  which is much less than people assume — so the ask reads as
                  ordinary housekeeping rather than a warning about their
                  notes. */}
              <article>
                <header>
                  <strong>One last thing: watch the disk</strong>
                </header>
                <p class="muted">
                  This server's disk is a <b>copy</b>, not the original. Your notes live in{" "}
                  {progress()?.backend === "git" ? "your git repository" : "Obsidian Sync"}, and
                  everything here — the vault, the search index, the settings — is rebuilt from
                  there. If the volume were wiped tomorrow you would redeploy, run this wizard
                  again, and wait for the sync to finish. Nothing is lost that isn't already
                  somewhere else.
                </p>
                <p class="muted">
                  What a full disk does cost you is <i>service</i>: writes start failing and sync
                  stops, until you notice. So it is worth being told before that happens.
                </p>
                <p>
                  <b>Set a disk alert.</b> In Railway: your project →{" "}
                  <b>Observability</b> → the disk usage widget → the <b>⋮</b> menu →{" "}
                  <b>Add monitor</b>, and pick a threshold around 80%. Railway can notify you by
                  email, in-app, or webhook. Monitors need a <b>Pro</b> plan.
                </p>
                <p class="muted">
                  On Hobby there are no monitors, so size the volume generously instead — two to
                  three times your vault. Volumes can be grown later with no downtime, but they{" "}
                  <b>cannot be shrunk</b>, and Hobby caps at 5&nbsp;GB.
                </p>
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
          when={!c.originMismatch}
          fallback={
            <article>
              <header>
                <strong>This server needs a restart before you can claim it</strong>
              </header>
              <p>
                It started before it had a public domain, so it is still configured as{" "}
                <code>{c.originMismatch!.configured}</code> even though you reached it at{" "}
                <code>{c.originMismatch!.reachedAt}</code>. Creating an account now fails with{" "}
                <b>“Invalid origin”</b>, because sign-in only accepts the address the server
                thinks it has.
              </p>
              <p class="muted">
                <b>On Railway:</b> your service → <b>Deployments</b> → <b>Restart</b>. It will pick
                the domain up on the next boot. If it still shows this afterwards, set a{" "}
                <code>BASE_URL</code> variable to <code>https://{c.originMismatch!.reachedAt}</code>{" "}
                and redeploy.
              </p>
              <p class="muted">
                Nothing is lost by restarting, and the {c.windowMinutes}-minute claim window
                restarts with the server.
              </p>
            </article>
          }
        >
        <Show
          when={open()}
          fallback={
            <article>
              <header>
                <strong>Locked down</strong>
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
        </Show>
      )}
    </Show>
  );
}

function BackendStep(props: { onDone: () => void }) {
  const [busy, setBusy] = createSignal<"obsidian" | "git" | null>(null);

  async function choose(kind: "obsidian" | "git") {
    setBusy(kind);
    await setupChooseBackend(kind);
    setBusy(null);
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>How does your vault sync?</strong>
      </header>
      <p class="muted">
        notemesh keeps its own copy of your vault and needs a way to stay in step with your other
        devices. Pick whichever you already use — this can't be changed later without starting
        over.
      </p>

      <article class="choice">
        <header>
          <strong>Obsidian Sync</strong>
        </header>
        <p class="muted">
          The official service. Handles attachments and conflicts for you, and works with vaults
          of any shape. Requires an <b>Obsidian Sync subscription</b>, and this server stores your
          Obsidian account password so it can re-authenticate.
        </p>
        <button aria-busy={busy() === "obsidian"} disabled={busy() !== null} onClick={() => choose("obsidian")}>
          Use Obsidian Sync
        </button>
      </article>

      <article class="choice">
        <header>
          <strong>Git repository</strong>
        </header>
        <p class="muted">
          Any HTTPS git remote — GitHub, GitLab, Gitea, self-hosted. No subscription needed, and
          every change an assistant makes becomes a commit you can review and revert. Stores a
          scoped access token rather than an account password. Best for markdown-heavy vaults;
          git handles large binary attachments poorly.
        </p>
        <button
          class="secondary"
          aria-busy={busy() === "git"}
          disabled={busy() !== null}
          onClick={() => choose("git")}
        >
          Use a Git Repo
        </button>
      </article>
    </article>
  );
}

function GitStep(props: { onDone: () => void }) {
  const [remote, setRemote] = createSignal("");
  const [branch, setBranch] = createSignal("main");
  const [username, setUsername] = createSignal("");
  const [token, setToken] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await setupGitRepo(remote(), branch(), username(), token());
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "Could not link the repository.");
      return;
    }
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>Link your vault repository</strong>
      </header>
      <p class="muted">
        The HTTPS clone URL of the repo holding your vault. It can be empty if you're starting
        fresh. The token is stored encrypted on this server and only needs access to this one
        repository.
      </p>
      <form onSubmit={submit}>
        <label for="git-remote">Clone URL</label>
        <input
          id="git-remote"
          type="url"
          required
          placeholder="https://github.com/you/my-vault.git"
          value={remote()}
          onInput={(e) => setRemote(e.currentTarget.value)}
        />
        <div class="grid">
          <div>
            <label for="git-branch">Branch</label>
            <input id="git-branch" type="text" value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} />
          </div>
          <div>
            <label for="git-username">Username</label>
            <input
              id="git-username"
              type="text"
              placeholder="your GitHub username"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
          </div>
        </div>
        <label for="git-token">Access token</label>
        <input
          id="git-token"
          type="password"
          required
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
        />
        <small class="muted">
          On GitHub: a fine-grained personal access token scoped to this repository with{" "}
          <b>Contents: read and write</b>. Revoke it any time without affecting anything else.
        </small>
        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>
        <button type="submit" aria-busy={busy()} disabled={busy()}>
          {busy() ? "Cloning… (a large vault may take a while)" : "Link Repository & Start Sync"}
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
        <label for="ob-mfa">
          Two-factor code <span class="muted">— only if your Obsidian account uses one</span>
        </label>
        <input
          id="ob-mfa"
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder="123456"
          value={mfa()}
          onInput={(e) => setMfa(e.currentTarget.value)}
        />
        <small class="muted">
          Leave blank if you don't use two-factor. It has to be entered here rather than prompted
          for: the sync client asks for the code interactively, and a server has no way to answer.
          Get it from your authenticator just before submitting, since the codes expire quickly.
        </small>
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
                  <Show when={l.message?.includes("sign in again")}>
                    <div class="callout warn">
                      <p>
                        <b>The Obsidian session is gone.</b> Reload this page to sign in again —
                        the most common cause is a password that wasn't accepted, since the sync
                        client can report success without actually establishing a session.
                      </p>
                      <p class="muted">
                        These are your <b>Obsidian.md account</b> credentials, not your vault's
                        encryption password.
                      </p>
                      <button type="button" onClick={() => window.location.reload()}>
                        Sign In Again
                      </button>
                    </div>
                  </Show>
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

// Which zone "today" means. The container runs in UTC, so without this an
// evening daily note in the Americas is filed under tomorrow's date. Asked here
// rather than left to Settings because the failure is silent and only shows up
// once someone is already relying on daily notes.
function TimezoneStep(props: { onDone: () => void }) {
  // The browser knows the answer, so offer it rather than asking for typing.
  // Client-only: Intl on the server resolves to the container's zone, which is
  // exactly the UTC we are trying to correct for.
  const [tz, setTz] = createSignal("");
  onMount(() => {
    try {
      setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    } catch {
      setTz("UTC");
    }
  });

  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Rendered in the chosen zone so the choice can be checked at a glance —
  // if the date shown isn't today where you are, the zone is wrong.
  const preview = () => {
    const zone = tz().trim();
    if (!zone) return "";
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date());
    } catch {
      return "";
    }
  };

  async function save(zone: string) {
    setBusy(true);
    setError(null);
    const res = await setTimezone(zone);
    setBusy(false);
    if (!res.ok) {
      setError(res.message ?? "That timezone wasn't accepted.");
      return;
    }
    props.onDone();
  }

  return (
    <article>
      <header>
        <strong>Set your timezone</strong>
      </header>
      <p class="muted">
        This decides what "today" means for daily notes. The server itself runs on UTC, so without
        it an evening note can land on tomorrow's date.
      </p>
      <label for="tz">Timezone</label>
      <input
        id="tz"
        value={tz()}
        onInput={(e) => setTz(e.currentTarget.value)}
        placeholder="America/Los_Angeles"
        autocomplete="off"
      />
      <Show when={preview()}>
        <p class="muted">
          Right now that reads as <b>{preview()}</b>.
        </p>
      </Show>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
      <div class="actions">
        <button aria-busy={busy()} disabled={busy() || !tz().trim()} onClick={() => save(tz())}>
          {busy() ? "Saving…" : "Save Timezone"}
        </button>
        <button class="secondary" disabled={busy()} onClick={() => save("UTC")}>
          Use UTC
        </button>
      </div>
      <small class="muted">You can change this later under Settings.</small>
    </article>
  );
}
