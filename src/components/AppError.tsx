import { Show } from "solid-js";
import { ApiError } from "~/lib/api";

/**
 * What a failure looks like to the operator.
 *
 * Two cases, told apart by where the failure happened, because the right amount
 * of detail differs:
 *
 * - **The server threw.** The message is a reference id and nothing else; the
 *   stack is in the server log beside the same id. That split exists because
 *   the public procedures answer people who are not signed in, and an
 *   unexpected error's text tends to carry absolute paths and schema details.
 *
 * - **The browser threw.** The whole stack goes on screen, folded away. There
 *   is nothing to protect: this is the operator's own deployment, the source is
 *   public, and the alternative — the bare "Uncaught Client Exception" this
 *   replaces — told them nothing they could act on or report.
 */
export function AppError(props: { error: unknown; reset?: () => void }) {
  const err = () => props.error;
  const api = () => (err() instanceof ApiError ? (err() as ApiError) : null);
  const stack = () => {
    const e = err();
    return e instanceof Error ? (e.stack ?? e.message) : String(e);
  };

  return (
    <main class="container">
      <article>
        <header>
          <strong>Something went wrong</strong>
        </header>

        <Show
          when={api()}
          fallback={
            <>
              <p>
                This page hit an error in the browser before it could finish. Nothing on the server
                changed.
              </p>
              <details class="error-detail">
                <summary>Technical detail</summary>
                <pre>{stack()}</pre>
              </details>
              <p class="muted">
                Worth reporting — the trace above is the whole of what happened, and it is enough to
                fix it.
              </p>
            </>
          }
        >
          <p>{api()!.message}</p>
          <Show when={api()!.errorId}>
            <p class="muted">
              Reference <code>{api()!.errorId}</code> — search your server log for it to see what
              actually failed.
            </p>
          </Show>
        </Show>

        <Show when={props.reset}>
          <button onClick={() => props.reset!()}>Try again</button>
        </Show>
      </article>
    </main>
  );
}
