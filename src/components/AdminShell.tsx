import { createSignal, type JSX } from "solid-js";
import { A } from "@solidjs/router";
import { authClient } from "~/lib/auth-client";

const TABS = [
  { href: "/", label: "Setup" },
  { href: "/status", label: "Status" },
  { href: "/settings", label: "Settings" },
  { href: "/security", label: "Security" },
];

const REPO_URL = "https://github.com/ChangeNode/ob-sync";

// Sits at the bottom of every page, signed in or not, so the source is always
// one click away from whatever the operator is looking at.
export function RepoFooter() {
  return (
    <>
      <hr />
      <p class="muted repo-footer">
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
          ob-sync on GitHub
        </a>
      </p>
    </>
  );
}

// Shared chrome for the four admin tabs. Each page renders its own cards
// inside this so the nav stays identical and client-side navigation between
// tabs doesn't remount the whole document.
export function AdminShell(props: { children: JSX.Element }) {
  return (
    <main class="container">
      <nav>
        <ul>
          <li>
            <a class="brand" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <strong>ob-sync</strong>
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
      {props.children}
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
