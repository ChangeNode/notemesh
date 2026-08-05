/**
 * The shape of the admin-reset state, and how a page should render it.
 *
 * In `lib/` rather than `server/` because the sign-in page needs it, and
 * anything a route module imports gets bundled for the browser. When this lived
 * in server/reset.ts it dragged `./db` — and therefore better-sqlite3 — into the
 * client bundle, where it failed to initialise. The sign-in component then never
 * mounted, its submit handler never attached, and the form fell back to a native
 * submit: the page reloaded, the fields cleared, and no error appeared, because
 * no JavaScript was running to show one.
 *
 * So: no imports here, and nothing that reads state. Pure data and a pure
 * mapping, safe on either side.
 */
export type ResetState =
  | { mode: "off" }
  | { mode: "open"; secondsLeft: number; windowMinutes: number }
  | { mode: "expired"; windowMinutes: number }
  | { mode: "exhausted"; windowMinutes: number };

/**
 * Which card the sign-in page should show.
 *
 * Its own function because the page originally branched on "is the flow armed" —
 * one bit for three states — and so told someone whose window had closed that
 * they could reset with the PIN from the log. Deciding it here means every mode
 * can be checked without a browser.
 */
export type ResetBanner =
  /** Not armed: fold away the how-to. */
  | "instructions"
  /** Armed and usable: link to the reset page. */
  | "armed"
  /** Armed but out of window or attempts: say so, and do not offer the link. */
  | "unusable";

export function resetBanner(state: ResetState): ResetBanner {
  switch (state.mode) {
    case "off":
      return "instructions";
    case "open":
      return "armed";
    case "expired":
    case "exhausted":
      return "unusable";
  }
}
