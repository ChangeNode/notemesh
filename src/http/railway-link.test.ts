import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAdmin, markConfigured, rpc, startServer, type Server } from "./harness";

/**
 * The Railway link has to survive the trip to the Status page, not just build
 * correctly.
 *
 * env.ts is unit-tested for when the URL exists and when it does not. This is
 * the other half — that it actually reaches the client — because a helper that
 * works and a page that never receives its value is the shape of bug this
 * project keeps finding.
 */

let server: Server;
let cookie: string;

beforeAll(async () => {
  server = await startServer({
    RAILWAY_PROJECT_ID: "a0175de5-2870-4c27-9dda-3c0f80110512",
    RAILWAY_SERVICE_ID: "6b3961eb-10f3-4702-b6cc-dc2896bb0fe3",
  });
  cookie = await claimAdmin(server);
  await markConfigured(server);
}, 60_000);

afterAll(async () => {
  await server.stop();
});

describe("a deployment running on Railway", () => {
  it("hands the Status page a link to its own service", async () => {
    const res = await rpc(server, "getStatusPage", [], cookie);
    expect(res.status).toBe(200);

    const { railwayUrl } = res.body.result as { railwayUrl: string | null };
    expect(railwayUrl).toBe(
      "https://railway.com/project/a0175de5-2870-4c27-9dda-3c0f80110512" +
        "/service/6b3961eb-10f3-4702-b6cc-dc2896bb0fe3/settings",
    );
  });
});
