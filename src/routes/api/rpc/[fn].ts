import { randomBytes } from "node:crypto";
import { json } from "@solidjs/router";
import type { APIEvent } from "@solidjs/start/server";
import { PublicError } from "~/server/public-error";

/**
 * The one door between the browser and the server.
 *
 * This replaces SolidStart's `"use server"` functions. Those are more
 * convenient — a route component imports one and calls it directly — but the
 * convenience comes from compiling the *same source file* twice, and the
 * directive only strips function bodies, not module-level imports. A component
 * importing one pure helper from a server module drags that module's whole
 * import graph into the browser bundle. That is not a hypothetical: it shipped
 * better-sqlite3 to the client, the chunk threw on load, and the sign-in form
 * silently stopped working with no error, because no JavaScript was left
 * running to show one. TypeScript cannot see it, the server build cannot see
 * it, and it only fails in a browser.
 *
 * Here the boundary is physical. API routes are never part of the client build,
 * so `src/server/**` is unreachable from the browser by construction rather than
 * by discipline. The client talks to this over HTTP through `src/lib/api.ts` and
 * shares nothing but types, which are erased at compile time.
 *
 * Deliberately one dispatch route rather than thirty REST endpoints: these are
 * procedure calls for a single-user admin panel, not a resource API, and
 * pretending otherwise would invent nouns nobody needs. The handler table is
 * the whole surface, so what is reachable is one list rather than a directory
 * to audit.
 */

// Handlers reached without a session. Everything else requires an admin, which
// each server function enforces itself with requireAdmin() — this table decides
// what may be *called*, not what it may do.
const PUBLIC = new Set([
  // The wizard runs before an account exists.
  "getSetupStage",
  "getSetupProgress",
  "getClaimState",
  "setupChooseBackend",
  "setupGitRepo",
  "setupObsidianLogin",
  "setupListVaults",
  "setupConfigureVault",
  // Password reset: the entire premise is that nobody can sign in.
  "getResetState",
  "submitAdminReset",
]);

type Handler = (...args: never[]) => Promise<unknown>;

/**
 * Every procedure this server exposes, named one at a time.
 *
 * This replaced a resolver that looked the name up as a property of three
 * server modules. That worked, but it published whatever those modules happened
 * to export — so adding an exported helper to admin.ts silently added an
 * endpoint, and the only thing standing between that and a live procedure was
 * remembering. It failed open; a list fails closed.
 *
 * Still imported lazily, per entry, for the two reasons the old resolver was:
 * a request loads only the module it needs, and a module that throws on import
 * cannot take the others down with it.
 */
const HANDLERS: Record<string, () => Promise<Handler>> = {
  // ---- Dashboard ----
  getSetupPage: async () => (await import("~/server/admin")).getSetupPage,
  getKeysPage: async () => (await import("~/server/admin")).getKeysPage,
  getStatusPage: async () => (await import("~/server/admin")).getStatusPage,
  getToolsPage: async () => (await import("~/server/admin")).getToolsPage,
  getSettingsPage: async () => (await import("~/server/admin")).getSettingsPage,
  getSecurityPage: async () => (await import("~/server/admin")).getSecurityPage,
  getSyncActivity: async () => (await import("~/server/admin")).getSyncActivity,
  createApiKey: async () => (await import("~/server/admin")).createApiKey,
  deleteApiKey: async () => (await import("~/server/admin")).deleteApiKey,
  revokeOAuthClient: async () => (await import("~/server/admin")).revokeOAuthClient,
  setGitTiming: async () => (await import("~/server/admin")).setGitTiming,
  setGitConflictStrategy: async () => (await import("~/server/admin")).setGitConflictStrategy,
  setTimezone: async () => (await import("~/server/admin")).setTimezone,
  setDeleteEnabled: async () => (await import("~/server/admin")).setDeleteEnabled,
  syncNow: async () => (await import("~/server/admin")).syncNow,
  stopSync: async () => (await import("~/server/admin")).stopSync,
  restartSync: async () => (await import("~/server/admin")).restartSync,
  rebuildIndex: async () => (await import("~/server/admin")).rebuildIndex,
  reauth: async () => (await import("~/server/admin")).reauth,

  // ---- Setup wizard ----
  getSetupStage: async () => (await import("~/server/setup")).getSetupStage,
  getSetupProgress: async () => (await import("~/server/setup")).getSetupProgress,
  getClaimState: async () => (await import("~/server/setup")).getClaimState,
  relinkVault: async () => (await import("~/server/setup")).relinkVault,
  setupChooseBackend: async () => (await import("~/server/setup")).setupChooseBackend,
  setupGitRepo: async () => (await import("~/server/setup")).setupGitRepo,
  setupObsidianLogin: async () => (await import("~/server/setup")).setupObsidianLogin,
  setupListVaults: async () => (await import("~/server/setup")).setupListVaults,
  setupConfigureVault: async () => (await import("~/server/setup")).setupConfigureVault,

  // ---- Admin password reset ----
  getResetState: async () => (await import("~/server/reset-actions")).getResetState,
  submitAdminReset: async () => (await import("~/server/reset-actions")).submitAdminReset,
};

/** Names this route serves, for the test that keeps the access lists honest. */
export const HANDLER_NAMES = Object.keys(HANDLERS);

async function resolve(fn: string): Promise<Handler | null> {
  const load = Object.prototype.hasOwnProperty.call(HANDLERS, fn) ? HANDLERS[fn] : undefined;
  return load ? await load() : null;
}

// Without these the file-router has no handler for the method, the request
// falls through to the catch-all, and the caller gets the SPA shell under a
// 200 — the same "HTML where JSON was expected" failure the middleware already
// guards against for unknown /api paths.
function methodNotAllowed() {
  return json(
    { error: "method_not_allowed", message: "Procedures are called with POST." },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/**
 * Nobody sends a megabyte of procedure arguments.
 *
 * The bodies here are a handful of short strings. The previous absence of any
 * cap meant an unauthenticated caller could push 96MB in — measured — because
 * the body was read and parsed before the session was checked.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** Arguments are spread into the handler, and a spread has a stack limit. */
const MAX_ARGS = 32;

/**
 * Same-origin only, when the caller says where it came from.
 *
 * The session cookie is SameSite=Lax, which already stops a browser sending it
 * on a cross-site POST — but that was the only thing standing between a page on
 * another origin and this route, and one control is not a spare. Chrome's
 * Lax+POST grace period alone leaves a couple of minutes after sign-in where
 * the cookie does travel.
 *
 * A missing Origin is allowed: every browser sends one on a cross-site POST, so
 * its absence means the caller is not a browser being tricked — it is curl, a
 * script, or a test. Compared against the request's own Host as well as the
 * configured base URL, so an instance reached at a domain it was not configured
 * with still works rather than locking the operator out of their own dashboard.
 */
function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // Unparseable Origin: not something to give the benefit of.
  }

  const requestHost = request.headers.get("host");
  if (requestHost && host === requestHost) return true;

  try {
    return host === new URL(process.env.BASE_URL ?? "").host;
  } catch {
    return false;
  }
}

/** Read the body with a byte cap, counting as it arrives rather than after. */
async function readCappedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function POST(event: APIEvent) {
  const fn = event.params.fn;
  if (!fn || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(fn)) {
    return json({ error: "bad_request", message: "Invalid procedure name." }, { status: 400 });
  }

  if (!originAllowed(event.request)) {
    return json(
      { error: "forbidden", message: "Cross-origin requests are not accepted here." },
      { status: 403 },
    );
  }

  const handler = await resolve(fn);
  if (typeof handler !== "function") {
    return json({ error: "not_found", message: `No procedure "${fn}".` }, { status: 404 });
  }

  // Gate before reading the body, not after. The handlers still call
  // requireAdmin() themselves — this is defence in depth, and it means adding a
  // handler without thinking about access fails closed rather than open.
  // Checking it first also means an unauthenticated caller cannot make the
  // server buffer and parse anything at all.
  if (!PUBLIC.has(fn)) {
    const { auth } = await import("~/server/auth");
    const session = await auth.api.getSession({ headers: event.request.headers });
    if (!session) {
      return json({ error: "unauthorized", message: "Sign in first." }, { status: 401 });
    }
  }

  const body = await readCappedBody(event.request);
  if (body === null) {
    return json({ error: "too_large", message: "Request body is too large." }, { status: 413 });
  }

  let args: unknown[] = [];
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        return json({ error: "bad_request", message: "Body must be a JSON array." }, { status: 400 });
      }
      args = parsed;
    } catch {
      return json({ error: "bad_request", message: "Body must be JSON." }, { status: 400 });
    }
  }
  if (args.length > MAX_ARGS) {
    // Spreading a large array into a call overflows the stack, which surfaced
    // as a 500 carrying "Maximum call stack size exceeded".
    return json(
      { error: "bad_request", message: `At most ${MAX_ARGS} arguments.` },
      { status: 400 },
    );
  }

  try {
    return json({ result: await handler(...(args as never[])) });
  } catch (e: unknown) {
    // A redirect thrown by requireAdmin() is control flow, not an error.
    if (e instanceof Response) return e;

    // A handler that deliberately raises something for the operator to read
    // says so by type; everything else is an accident and its text is not for
    // a stranger. The old code returned e.message verbatim, and the public
    // handlers are reachable without a session, so an unexpected throw handed
    // out absolute paths and SQLite messages.
    if (e instanceof PublicError) {
      return json({ error: "failed", message: e.message }, { status: e.status });
    }

    // One identifier, printed beside the detail in the log and shown to the
    // operator, so "it broke" and the stack trace can be connected without
    // either putting the detail on screen or guessing which log line was
    // theirs.
    const errorId = randomBytes(4).toString("hex");
    console.error(`[rpc] ${fn} failed [${errorId}]:`, e);
    return json(
      {
        error: "failed",
        errorId,
        message: `Something went wrong on the server. Reference ${errorId} — the details are in the server log.`,
      },
      { status: 500 },
    );
  }
}
