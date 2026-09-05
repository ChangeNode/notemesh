import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { startServer, type Server } from "./harness";

/**
 * The first-claim race, over real HTTP against the built server.
 *
 * The sign-up hook counts users before Better Auth inserts one, and the two
 * are not one step: ten simultaneous claims all counted zero and all became
 * admins. The guard now lives in the database (claim.ts), so exactly one of
 * them can win, and the losers get the same refusal a late claim gets rather
 * than a server error.
 */

let server: Server;

beforeAll(async () => {
  server = await startServer();
}, 60_000);

afterAll(async () => {
  await server?.stop();
});

async function signUp(email: string) {
  const res = await fetch(`${server.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: server.url },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple", name: email.split("@")[0] }),
  });
  return { status: res.status, body: await res.text(), cookie: res.headers.get("set-cookie") };
}

describe("ten simultaneous first claims", () => {
  it("produce exactly one admin, and nine refusals that are not server errors", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => signUp(`racer${i}@example.com`)),
    );
    const statuses = results.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 403)).toHaveLength(9);
    expect(statuses.some((s) => s >= 500)).toBe(false);
    for (const r of results.filter((r) => r.status === 403)) {
      expect(r.body).toMatch(/already claimed/i);
      expect(r.cookie).toBeNull();
    }

    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path.join(server.dataDir, "app.sqlite"), { readonly: true });
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
    db.close();
    expect(n).toBe(1);

    // The winner is a working admin: it can sign in.
    const winner = results.find((r) => r.status === 200)!;
    const email = JSON.parse(winner.body).user.email as string;
    const signIn = await fetch(`${server.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url },
      body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
    });
    expect(signIn.status).toBe(200);
  }, 30_000);
});
