import { createResource, createSignal, Show } from "solid-js";
import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import { resetBanner } from "~/lib/reset-view";
import { RepoFooter } from "~/components/AdminShell";
import { api } from "~/lib/api";

export default function Login() {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [reset] = createResource(() => api.getResetState());

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: email(),
      password: password(),
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Sign-in failed");
      return;
    }
    // During an OAuth authorization flow the server answers sign-in with a
    // redirect that resumes the flow (consent page or client callback).
    const oauthUrl = (data as any)?.url;
    if ((data as any)?.redirect && typeof oauthUrl === "string") {
      window.location.href = oauthUrl;
      return;
    }
    // Send an unfinished instance to the wizard rather than to a dashboard
    // that has no vault behind it yet.
    const stage = await api.getSetupStage().catch(() => "done" as const);
    if (stage !== "done") {
      navigate("/setup", { replace: true });
      return;
    }
    const dest = typeof params.redirect === "string" ? params.redirect : "/";
    if (dest.startsWith("/")) {
      navigate(dest, { replace: true });
    } else {
      window.location.href = "/";
    }
  }

  return (
    <main class="container">
      <article>
        <header>
          <strong>Sign in — NoteMesh</strong>
        </header>
        <form onSubmit={submit}>
          <label for="email">Email</label>
          <input
            id="email"
            type="email"
            autocomplete="username"
            required
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
          <label for="password">Password</label>
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            required
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
          <button type="submit" aria-busy={busy()} disabled={busy()}>
            Sign In
          </button>
        </form>
      </article>

      {/* Armed and usable: link straight to it, because someone reaching this
          page in that state is almost certainly here to use it. Armed but out
          of window or attempts says so here rather than letting the reset page
          deliver the bad news after a click. Not armed at all: explain how to
          arm it, folded away so it does not clutter an ordinary sign-in. */}
      <Show
        when={reset() && resetBanner(reset()!) !== "instructions"}
        fallback={
          <article>
            <details>
              <summary>How To Reset Your Admin Password</summary>
              <p class="muted">
                There is no password reset email — this server has no way to send one, and no
                account anywhere but here. Instead you prove you control the deployment, by setting
                a variable only its owner can set.
              </p>
              <ol>
                <li>
                  Set <code>RESET_ADMIN_FLOW</code> to <code>1</code> in your server's environment
                  variables. On Railway: your service → <b>Variables</b> → <b>New Variable</b>.
                  Saving it redeploys the service, which is what arms the reset.
                </li>
                <li>
                  Open the service's <b>Logs</b> and find the block headed{" "}
                  <b>ADMIN PASSWORD RESET ARMED</b>. It contains an eight-digit PIN, generated fresh
                  on every start.
                </li>
                <li>
                  Come back to this page and follow the reset link, which appears once the variable
                  is set. Enter the PIN and choose a new password.
                </li>
                <li>
                  <b>Delete the variable afterwards.</b> While it is set, every restart issues a new
                  PIN and reopens the window.
                </li>
              </ol>
              <p class="muted">
                The window is open for 30 minutes after the server starts, and the PIN may be
                entered a limited number of times before a restart is required. Both exist so that
                leaving the variable set by accident is not the same as leaving the door open.
              </p>
            </details>
          </article>
        }
      >
        <Show
          when={resetBanner(reset()!) === "armed"}
          fallback={
            <article>
              <header>
                <strong>
                  {reset()!.mode === "exhausted"
                    ? "Password reset is locked out"
                    : "The password reset window has closed"}
                </strong>
              </header>
              <p class="muted">
                <code>RESET_ADMIN_FLOW</code> is still set, but{" "}
                {reset()!.mode === "exhausted"
                  ? "the PIN was entered incorrectly too many times"
                  : "a reset is only possible in the first 30 minutes after the server starts"}
                . Restart the server to get a new PIN and a fresh window — on Railway, your service
                → <b>Deployments</b> → <b>Restart</b>. If you did not mean to leave the reset armed,
                delete the variable instead.
              </p>
            </article>
          }
        >
          <article>
            <header>
              <strong>Password reset is armed</strong>
            </header>
            <p class="muted">
              <code>RESET_ADMIN_FLOW</code> is set on this server, so the admin password can be
              changed with the PIN printed in its log. Remove the variable once you are done.
            </p>
            <A href="/reset" role="button">
              Reset Admin Password
            </A>
          </article>
        </Show>
      </Show>

      <RepoFooter />
    </main>
  );
}
