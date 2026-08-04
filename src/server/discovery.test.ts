import { describe, expect, it } from "vitest";
import { discoveryEndpoint } from "./discovery";

// These paths are how an MCP client finds the authorization server. When one is
// missing the client gets SolidStart's SPA shell — HTML with a 200 — and the
// failure surfaces as an unreadable JSON parse error rather than a 404, which
// is why the list is pinned here rather than left to a boot-time warning.

describe("authorization server metadata", () => {
  it("serves the RFC 8414 path-inserted form", () => {
    // The issuer is <base>/api/auth, so a compliant client inserts that path
    // after the well-known segment. This is the exact path the oauth-provider
    // plugin warns about and that we silenced the warning for.
    expect(discoveryEndpoint("/.well-known/oauth-authorization-server/api/auth")).toBe(
      "auth-server",
    );
  });

  it("also serves the bare form, which some clients ask for", () => {
    expect(discoveryEndpoint("/.well-known/oauth-authorization-server")).toBe("auth-server");
  });
});

describe("openid configuration", () => {
  it.each([
    "/.well-known/openid-configuration",
    "/.well-known/openid-configuration/api/auth",
    "/api/auth/.well-known/openid-configuration", // legacy issuer-prefixed form
  ])("serves %s", (p) => {
    expect(discoveryEndpoint(p)).toBe("openid");
  });
});

describe("protected resource metadata", () => {
  it("serves the resource document the MCP spec requires", () => {
    expect(discoveryEndpoint("/.well-known/oauth-protected-resource")).toBe("protected-resource");
  });
});

describe("everything else falls through", () => {
  it.each([
    "/",
    "/api/mcp",
    "/api/auth/oauth2/authorize",
    "/.well-known",
    "/.well-known/",
    "/.well-known/unrelated",
    "/setup",
  ])("does not claim %s", (p) => {
    expect(discoveryEndpoint(p)).toBeNull();
  });

  it("does not match on a prefix", () => {
    // Exact matching: a longer path that merely starts with a known one must
    // not be answered with the wrong document.
    expect(discoveryEndpoint("/.well-known/oauth-protected-resource/extra")).toBeNull();
    expect(discoveryEndpoint("/.well-known/oauth-authorization-server/api/auth/extra")).toBeNull();
  });

  it("does not match a similarly named endpoint", () => {
    expect(discoveryEndpoint("/.well-known/oauth-authorization-server-x")).toBeNull();
  });
});
