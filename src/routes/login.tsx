import { createSignal, Show } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import { getSetupStage } from "~/server/setup";
import { RepoFooter } from "~/components/AdminShell";

export default function Login() {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();

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
    const stage = await getSetupStage().catch(() => "done" as const);
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
          <strong>Sign in — ob-sync</strong>
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
      <RepoFooter />
    </main>
  );
}
