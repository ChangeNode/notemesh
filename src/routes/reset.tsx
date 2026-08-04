import { createResource, createSignal, Show, Match, Switch } from "solid-js";
import { A } from "@solidjs/router";
import { getResetState, submitAdminReset } from "~/server/reset-actions";
import { RepoFooter } from "~/components/AdminShell";

export default function Reset() {
  const [state, { refetch }] = createResource(() => getResetState());
  const [pin, setPin] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [done, setDone] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    if (password() !== confirm()) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    const res = await submitAdminReset(pin(), password());
    setBusy(false);
    if (!res.ok) {
      setError(
        res.attemptsLeft !== undefined
          ? `${res.message} ${res.attemptsLeft} attempt${res.attemptsLeft === 1 ? "" : "s"} left before a restart is needed.`
          : (res.message ?? "That didn't work."),
      );
      // The window or the attempt budget may have just run out.
      refetch();
      return;
    }
    setDone(res.email ?? null);
  }

  return (
    <main class="container">
      <Show when={done()} keyed fallback={<ResetForm />}>
        {(email) => (
          <article>
            <header>
              <strong>Password changed</strong>
            </header>
            <p>
              The password for <b>{email}</b> has been reset, and every existing session was signed
              out.
            </p>
            <div class="callout warn">
              <p>
                <b>Remove the RESET_ADMIN_FLOW variable now.</b> While it is set, every restart
                prints a new PIN and reopens the reset window — which is a way into this server for
                anyone who can read its logs.
              </p>
              <p class="muted">
                On Railway: your service → <b>Variables</b> → delete <code>RESET_ADMIN_FLOW</code>.
                Removing it triggers a redeploy, which is all that is needed.
              </p>
            </div>
            <A href="/login" role="button">
              Go to Sign In
            </A>
          </article>
        )}
      </Show>
      <RepoFooter />
    </main>
  );

  function ResetForm() {
    return (
      <Show when={state()} keyed>
        {(s) => (
          <Switch>
            <Match when={s.mode === "off"}>
              <article>
                <header>
                  <strong>Password reset is not enabled</strong>
                </header>
                <p class="muted">
                  This server only accepts a password reset when it is started with the{" "}
                  <code>RESET_ADMIN_FLOW</code> environment variable set to <code>1</code>. The sign
                  in page explains how.
                </p>
                <A href="/login" role="button" class="secondary">
                  Back to Sign In
                </A>
              </article>
            </Match>

            <Match when={s.mode === "expired" || s.mode === "exhausted"}>
              <article>
                <header>
                  <strong>
                    {s.mode === "exhausted" ? "Too many attempts" : "The reset window has closed"}
                  </strong>
                </header>
                <p>
                  {s.mode === "exhausted"
                    ? "The PIN was entered incorrectly too many times."
                    : `A reset is only possible in the first ${(s as { windowMinutes: number }).windowMinutes} minutes after the server starts.`}
                </p>
                <p class="muted">
                  Restart the server to get a new PIN and another{" "}
                  {(s as { windowMinutes: number }).windowMinutes} minutes. On Railway: your service
                  → <b>Deployments</b> → <b>Restart</b>. Nothing is lost by restarting.
                </p>
              </article>
            </Match>

            <Match when={s.mode === "open"}>
              <article>
                <header>
                  <strong>Reset the admin password</strong>
                </header>
                <p class="muted">
                  The server printed an eight-digit PIN to its log when it started. On Railway you
                  will find it under your service → <b>Deployments</b> → the running deployment →{" "}
                  <b>Logs</b>, in a block headed <b>ADMIN PASSWORD RESET ARMED</b>.
                </p>
                <p>
                  <b>
                    Time remaining:{" "}
                    {formatRemaining((s as { secondsLeft: number }).secondsLeft)}
                  </b>
                </p>
                <form onSubmit={submit}>
                  <label for="pin">PIN from the server log</label>
                  <input
                    id="pin"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    placeholder="12345678"
                    required
                    value={pin()}
                    onInput={(e) => setPin(e.currentTarget.value)}
                  />
                  <label for="password">New password</label>
                  <input
                    id="password"
                    type="password"
                    autocomplete="new-password"
                    required
                    minlength={10}
                    value={password()}
                    onInput={(e) => setPassword(e.currentTarget.value)}
                  />
                  <label for="confirm">Confirm new password</label>
                  <input
                    id="confirm"
                    type="password"
                    autocomplete="new-password"
                    required
                    minlength={10}
                    value={confirm()}
                    onInput={(e) => setConfirm(e.currentTarget.value)}
                  />
                  <Show when={error()}>
                    <p class="error">{error()}</p>
                  </Show>
                  <button type="submit" aria-busy={busy()} disabled={busy()}>
                    {busy() ? "Resetting…" : "Reset Password"}
                  </button>
                </form>
              </article>
            </Match>
          </Switch>
        )}
      </Show>
    );
  }
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m <= 0) return `${seconds}s`;
  return `${m}m`;
}
