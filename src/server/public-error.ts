/**
 * An error whose message is meant for the operator to read.
 *
 * The RPC route returns this text as-is and returns nothing but a reference id
 * for anything else. That split is the point: a handler that wants to explain a
 * refusal says so by type, and an unexpected throw — a filesystem error
 * carrying an absolute path, a SQLite message naming a column — cannot leak its
 * text simply because it reached the same catch block. The public handlers are
 * reachable without a session, so that catch block answers strangers.
 *
 * Most handlers here do not need this: they return `{ ok: false, message }` for
 * expected failures, which was always the better shape and stays unchanged.
 * This is for the cases where throwing is genuinely more natural.
 */
export class PublicError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}
