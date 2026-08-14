import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimAdmin, markConfigured, rpc, startServer, type Server } from "./harness";

/**
 * The Railway links have to survive the trip to the Settings page, not just
 * build correctly.
 *
 * env.ts is unit-tested for when they exist and when they do not. This is the
 * other half — that they actually reach the client — because a helper that
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
  it("hands the Settings page both links", async () => {
    const res = await rpc(server, "getSettingsPage", [], cookie);
    expect(res.status).toBe(200);

    const { railway } = res.body.result as {
      railway: { project: string; service: string } | null;
    };
    expect(railway).toEqual({
      project: "https://railway.com/project/a0175de5-2870-4c27-9dda-3c0f80110512",
      service:
        "https://railway.com/project/a0175de5-2870-4c27-9dda-3c0f80110512" +
        "/service/6b3961eb-10f3-4702-b6cc-dc2896bb0fe3/settings",
    });
  });

  it("does not leave the links on the Status page it moved off", async () => {
    // They lived here first. A stale copy would not break anything visibly,
    // which is exactly why it would survive.
    const res = await rpc(server, "getStatusPage", [], cookie);
    expect(res.body.result).not.toHaveProperty("railwayUrl");
    expect(res.body.result).not.toHaveProperty("railway");
  });
});
