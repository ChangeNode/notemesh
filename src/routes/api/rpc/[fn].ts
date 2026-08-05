import { json } from "@solidjs/router";
import type { APIEvent } from "@solidjs/start/server";

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

// Imported inside the resolver so a request only loads the module it needs, and
// so a failure in one area cannot stop the others being served.
async function resolve(fn: string): Promise<Handler | null> {
  if (fn in (await import("~/server/admin"))) {
    return (await import("~/server/admin"))[fn as never] as Handler;
  }
  if (fn in (await import("~/server/setup"))) {
    return (await import("~/server/setup"))[fn as never] as Handler;
  }
  if (fn in (await import("~/server/reset-actions"))) {
    return (await import("~/server/reset-actions"))[fn as never] as Handler;
  }
  return null;
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

export async function POST(event: APIEvent) {
  const fn = event.params.fn;
  if (!fn || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(fn)) {
    return json({ error: "bad_request", message: "Invalid procedure name." }, { status: 400 });
  }

  let args: unknown[] = [];
  try {
    const body = await event.request.text();
    if (body) {
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed)) {
        return json({ error: "bad_request", message: "Body must be a JSON array." }, { status: 400 });
      }
      args = parsed;
    }
  } catch {
    return json({ error: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }

  const handler = await resolve(fn);
  if (typeof handler !== "function") {
    return json({ error: "not_found", message: `No procedure "${fn}".` }, { status: 404 });
  }

  // Gate before calling. The handlers still call requireAdmin() themselves —
  // this is defence in depth, and it means adding a handler without thinking
  // about access fails closed rather than open.
  if (!PUBLIC.has(fn)) {
    const { auth } = await import("~/server/auth");
    const session = await auth.api.getSession({ headers: event.request.headers });
    if (!session) {
      return json({ error: "unauthorized", message: "Sign in first." }, { status: 401 });
    }
  }

  try {
    return json({ result: await handler(...(args as never[])) });
  } catch (e: unknown) {
    // A redirect thrown by requireAdmin() is control flow, not an error.
    if (e instanceof Response) return e;
    const message = String((e as { message?: string })?.message ?? e);
    console.error(`[rpc] ${fn} failed:`, e);
    // Message text is safe to return: these handlers throw their own strings,
    // and anything unexpected has already been logged server-side.
    return json({ error: "failed", message }, { status: 500 });
  }
}
