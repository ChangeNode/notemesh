import { describe, expect, it } from "vitest";
import { pageAccess } from "./pages";

// The guard used to be an allow-list of protected pages, so a new admin route
// rendered to anyone until someone remembered to add it. It is now default
// closed. These pin both halves: that the deliberate exceptions still work, and
// that anything unlisted is protected without having to be named.

describe("admin pages are protected", () => {
  it.each(["/", "/status", "/keys", "/settings", "/security"])("protects %s", (p) => {
    expect(pageAccess(p)).toBe("protected");
  });

  it("protects a route nobody has thought of yet", () => {
    // The whole point. A page added tomorrow is closed on arrival; the failure
    // mode of getting this wrong is a redirect to the login form, which is
    // noticed at once, rather than a page served to strangers, which is not.
    for (const p of ["/logs", "/admin", "/backups", "/vault/browse", "/anything"]) {
      expect(pageAccess(p)).toBe("protected");
    }
  });

  it("protects a trailing-slash variant rather than letting it through", () => {
    expect(pageAccess("/status/")).toBe("protected");
  });

  it("does not treat a differently-cased public path as public", () => {
    expect(pageAccess("/Login")).toBe("protected");
  });
});

describe("public pages", () => {
  it.each(["/login", "/setup", "/oauth/consent"])("leaves %s reachable", (p) => {
    expect(pageAccess(p)).toBe("public");
  });

  it("keeps setup public, because it runs before any account exists", () => {
    // If this ever flipped to protected the wizard would redirect to a login
    // form that nobody can yet pass.
    expect(pageAccess("/setup")).toBe("public");
  });
});

describe("paths that are not pages", () => {
  it.each([
    "/api/health",
    "/api/mcp",
    "/api/auth/sign-in/email",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource",
  ])("passes %s through to its own access rules", (p) => {
    expect(pageAccess(p)).toBe("not-a-page");
  });

  it("never redirects server-function RPC", () => {
    // Every server function posts here. Redirecting it to the login form would
    // break the app outright — including the call that signs you in.
    expect(pageAccess("/_server")).toBe("not-a-page");
    expect(pageAccess("/_server/anything")).toBe("not-a-page");
  });

  it.each(["/favicon.ico", "/robots.txt", "/apple-touch-icon.png", "/_build/assets/x.js"])(
    "treats %s as a file, not a page",
    (p) => {
      expect(pageAccess(p)).toBe("not-a-page");
    },
  );

  it("only exempts a dot in the final segment", () => {
    // A dotted folder name must not open up everything beneath it.
    expect(pageAccess("/some.dir/status")).toBe("protected");
  });
});
