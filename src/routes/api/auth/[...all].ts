import { toSolidStartHandler } from "better-auth/solid-start";
import { auth, runAuthMigrations } from "~/server/auth";
import { userCount } from "~/server/claim";
import { audit } from "~/server/audit";
import { normalizeClientRegistration } from "~/server/oauth-registration";

const handler = toSolidStartHandler(auth);

async function withMigrations(
  fn: (event: { request: Request }) => Promise<Response>,
  event: { request: Request },
) {
  await runAuthMigrations();
  // A registration that says nothing about its application type and
  // redirects to plain-HTTP loopback is a native client; the provider would
  // read it as a web client and refuse it. See oauth-registration.ts.
  if (event.request.method === "POST" && new URL(event.request.url).pathname.endsWith("/oauth2/register")) {
    const original = event.request;
    const body = await original
      .clone()
      .json()
      .catch(() => undefined);
    const normalized = normalizeClientRegistration(body);
    if (body !== undefined && normalized !== body) {
      event = {
        request: new Request(original, { body: JSON.stringify(normalized), headers: original.headers }),
      };
    }
  }
  const res = await fn(event);
  // A sign-up that lost the race to the database guard (claim.ts) surfaces
  // from Better Auth as 422 FAILED_TO_CREATE_USER: the adapter's insert threw.
  // It is the same refusal the hook gives when the count is visible in time,
  // so it gets the same answer, rather than an error that reads as the server
  // being unable to create accounts at all.
  if (
    event.request.method === "POST" &&
    new URL(event.request.url).pathname.endsWith("/sign-up/email") &&
    res.status >= 400 &&
    res.status !== 403
  ) {
    const code = await res
      .clone()
      .json()
      .then((b: { code?: string } | null) => b?.code)
      .catch(() => undefined);
    const users = userCount();
    if ((code === "FAILED_TO_CREATE_USER" || res.status >= 500) && users.known && users.count > 0) {
      audit("signup.rejected", { reason: "already_claimed_race" });
      return Response.json(
        { code: "ALREADY_CLAIMED", message: "This instance is already claimed." },
        { status: 403 },
      );
    }
  }
  return res;
}

export const GET = (event: { request: Request }) => withMigrations(handler.GET, event);
export const POST = (event: { request: Request }) => withMigrations(handler.POST, event);
