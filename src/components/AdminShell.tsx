import { createEffect, createResource, createSignal, Show, type JSX } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";
import { api } from "~/lib/api";

const TABS = [
  { href: "/", label: "Setup" },
  { href: "/status", label: "Status" },
  { href: "/keys", label: "Keys" },
  { href: "/settings", label: "Settings" },
  { href: "/security", label: "Security" },
];

const REPO_URL = "https://github.com/ChangeNode/notemesh";
const VENDOR_URL = "https://changenode.com";

// Sits at the bottom of every page, signed in or not, so the source is always
// one click away from whatever the operator is looking at.
export function RepoFooter() {
  return (
    <>
      <hr />
      <p class="muted repo-footer">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          notemesh on GitHub
        </a>
        <span class="sep" aria-hidden="true">
          ·
        </span>
        <a href={VENDOR_URL} target="_blank" rel="noopener noreferrer">
          ChangeNode
        </a>
      </p>
    </>
  );
}

// Shared chrome for the admin tabs. Each page renders its own cards
// inside this so the nav stays identical and client-side navigation between
// tabs doesn't remount the whole document.
export function AdminShell(props: { children: JSX.Element }) {
  const navigate = useNavigate();
  // The middleware bounces an unfinished instance back to the wizard, but it
  // only runs on full page loads — a client-side navigation (signing in, or
  // any in-app link) skips it and would render admin tabs with no vault behind
  // them. Re-check here so every route into the dashboard is covered.
  const [stage] = createResource(() => api.getSetupStage());
  createEffect(() => {
    if (stage() && stage() !== "done") navigate("/setup", { replace: true });
  });

  return (
    <main class="container">
      <nav>
        <ul>
          <li>
            <a class="brand" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              {/* alt="" deliberately: the wordmark beside it already says
                  "notemesh", so describing the image would make a screen
                  reader announce the name twice. Width and height are set so
                  the row does not reflow when the SVG arrives. */}
              <img src="/favicon.svg" alt="" width="26" height="26" class="brand-mark" />
              <strong>notemesh</strong>
            </a>
          </li>
        </ul>
        <ul>
          <li>
            <button
              class="secondary outline"
              onClick={async () => {
                await authClient.signOut();
                window.location.href = "/login";
              }}
            >
              Sign Out
            </button>
          </li>
        </ul>
      </nav>
      <nav class="tabs">
        <ul>
          {TABS.map((t) => (
            <li>
              {/* `end` so "/" is only active on the exact path, not every route. */}
              <A href={t.href} end={t.href === "/"} activeClass="active">
                {t.label}
              </A>
            </li>
          ))}
        </ul>
      </nav>
      {/* Render nothing until setup is known to be finished, so an incomplete
          instance never flashes a broken dashboard before redirecting. */}
      <Show when={stage() === "done"}>{props.children}</Show>
      <RepoFooter />
    </main>
  );
}

// A copyable code line. Setup instructions are mostly URLs and commands that
// the user has to paste into another app, so make that one click.
export function Snippet(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="snippet">
      <pre>{props.text}</pre>
      <button
        type="button"
        class="secondary outline"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          } catch {
            // Clipboard denied (insecure origin, permissions) — the text is
            // still selectable, so just leave the label alone.
          }
        }}
      >
        {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Small labelled pass/warn/fail row, used by the Security tab.
//
// `detail` is read exactly once. JSX passed through a prop is re-created on
// every access, so reading it twice (e.g. to gate it behind a <Show>) builds a
// second set of DOM nodes and breaks hydration for any dynamic child.
export function Check(props: { state: "ok" | "warn" | "err"; label: string; detail: JSX.Element }) {
  return (
    <div class="check">
      <span class={`status-dot ${props.state}`} />
      <div>
        <b>{props.label}</b>
        <div class="muted">{props.detail}</div>
      </div>
    </div>
  );
}
