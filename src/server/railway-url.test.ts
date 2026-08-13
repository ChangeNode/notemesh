import { afterEach, describe, expect, it } from "vitest";
import { railwayServiceUrl } from "./env";

/**
 * The Status page's link back to the deployment's own Railway service.
 *
 * Both IDs are injected by Railway, so their presence is how the app knows it
 * is running there. Anywhere else — self-hosted, a container elsewhere, a local
 * run — nothing is shown, which is the whole reason this returns null rather
 * than a best guess.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("railwayServiceUrl", () => {
  it("builds the link when Railway injected both IDs", () => {
    process.env.RAILWAY_PROJECT_ID = "a0175de5-2870-4c27-9dda-3c0f80110512";
    process.env.RAILWAY_SERVICE_ID = "6b3961eb-10f3-4702-b6cc-dc2896bb0fe3";
    expect(railwayServiceUrl()).toBe(
      "https://railway.com/project/a0175de5-2870-4c27-9dda-3c0f80110512" +
        "/service/6b3961eb-10f3-4702-b6cc-dc2896bb0fe3/settings",
    );
  });

  it.each([
    ["neither", undefined, undefined],
    ["only the project", "a0175de5", undefined],
    ["only the service", undefined, "6b3961eb"],
  ])("shows nothing with %s", (_label, project, service) => {
    delete process.env.RAILWAY_PROJECT_ID;
    delete process.env.RAILWAY_SERVICE_ID;
    if (project) process.env.RAILWAY_PROJECT_ID = project;
    if (service) process.env.RAILWAY_SERVICE_ID = service;
    // Half a link is a broken link, so one ID alone is not enough.
    expect(railwayServiceUrl()).toBeNull();
  });

  it("treats blank and whitespace-only values as absent", () => {
    process.env.RAILWAY_PROJECT_ID = "   ";
    process.env.RAILWAY_SERVICE_ID = "6b3961eb";
    expect(railwayServiceUrl()).toBeNull();
  });

  it("encodes what it is given", () => {
    // Not a security boundary — an operator setting their own environment has
    // easier options — but these are external values going into a URL an admin
    // clicks, and a stray character should not silently reshape the path.
    process.env.RAILWAY_PROJECT_ID = "a/b";
    process.env.RAILWAY_SERVICE_ID = "c d";
    const url = railwayServiceUrl()!;
    expect(url).toContain("/project/a%2Fb/");
    expect(url).toContain("/service/c%20d/settings");
  });
});
