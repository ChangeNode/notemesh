import { toSolidStartHandler } from "better-auth/solid-start";
import { auth, runAuthMigrations } from "~/server/auth";

const handler = toSolidStartHandler(auth);

async function withMigrations(
  fn: (event: { request: Request }) => Promise<Response>,
  event: { request: Request },
) {
  await runAuthMigrations();
  return fn(event);
}

export const GET = (event: { request: Request }) => withMigrations(handler.GET, event);
export const POST = (event: { request: Request }) => withMigrations(handler.POST, event);
