import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startServer, type Server } from "./harness";

// auth.ts derives the session secret from ENCRYPTION_KEY at module load, so
// importing it for one constant needs a key in this process — separate from the
// one the spawned server generates for itself. Imported dynamically because the
// variable has to be set first.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { MAX_OAUTH_CLIENTS } = await import("~/server/auth");

/**
 * The cap on anonymous dynamic client registration.
 *
 * DCR is open by design — connectors self-register, and demanding a credential
 * first would defeat the point. That makes it the only unauthenticated write on
 * this server, and this cap the only thing between a stranger and an unbounded
 * number of rows.
 *
 * The rows are seeded directly rather than registered over HTTP, and that is
 * the whole difficulty of testing this. Better Auth rate-limits /api/auth/* at
 * around twenty requests, so a loop trying to reach fifty is refused at twenty
 * by something else entirely — with the message "Too many requests. Please try
 * again later." A first version of this test did exactly that, asserted
 * /too many/i, and passed while the cap was commented out. Seeding to the limit
 * and sending one request tests the cap and only the cap, and the assertion
 * below names its wording rather than matching anything that sounds similar.
 */

let server: Server;

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await server.stop();
});

/** Fill the client table to `count` rows, bypassing HTTP and its rate limit. */
async function seedClients(count: number) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(server.dataDir, "app.sqlite"));
  const insert = db.prepare(
    `INSERT INTO "oauthClient" (id, clientId, redirectUris, disabled, createdAt, updatedAt, name)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  );
  // Recent, so the pruning step that runs before the count cannot remove them:
  // it only evicts unused clients older than a day.
  const now = new Date().toISOString();
  const many = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(
        `seed-${i}`,
        `seed-client-${i}`,
        "https://example.com/cb",
        now,
        now,
        `seed ${i}`,
      );
    }
  });
  many();
  db.close();
}

function register(name: string) {
  return fetch(`${server.url}/api/auth/oauth2/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.url },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ["https://example.com/cb"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

describe("anonymous client registration", () => {
  it("is allowed on an instance with room", async () => {
    // First, and on a nearly empty table: a cap that refused everything would
    // satisfy the test below and break every connector.
    expect((await register("first")).status).toBe(200);
  });

  it("is refused once the instance is full", async () => {
    await seedClients(MAX_OAUTH_CLIENTS);

    const res = await register("one-too-many");
    expect(res.status).toBe(429);
    // The cap's own wording. Matching /too many/i instead would also accept the
    // rate limiter's "Too many requests", which is what made the first version
    // of this test pass with the cap removed.
    expect(JSON.stringify(await res.json())).toMatch(/too many registered oauth clients/i);
  }, 60_000);
});
