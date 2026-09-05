import { describe, expect, it } from "vitest";
import { applySecurityHeaders, arrivedOverHttps, CONTENT_SECURITY_POLICY, HSTS } from "./headers";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("applySecurityHeaders", () => {
  it("sets the baseline on a bare response", () => {
    const h = new Headers();
    applySecurityHeaders(req("http://localhost:3000/login"), h, "http://localhost:3000");
    expect(h.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("Referrer-Policy")).toBe("no-referrer");
    expect(h.get("Permissions-Policy")).toContain("camera=()");
  });

  it("carries the lines that matter with inline scripts still allowed", () => {
    for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"]) {
      expect(CONTENT_SECURITY_POLICY).toContain(directive);
    }
  });

  it("leaves a header the route already chose", () => {
    // The attachment route's own, stricter policy must not be replaced.
    const h = new Headers({ "Content-Security-Policy": "default-src 'none'; sandbox" });
    applySecurityHeaders(req("http://localhost:3000/api/attachment"), h, "http://localhost:3000");
    expect(h.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(h.get("X-Frame-Options")).toBe("DENY");
  });

  it("emits HSTS only for an HTTPS deployment reached over HTTPS", () => {
    const https = "https://notes.example.com";
    const on = new Headers();
    applySecurityHeaders(req("http://internal/login", { "x-forwarded-proto": "https" }), on, https);
    expect(on.get("Strict-Transport-Security")).toBe(HSTS);
    expect(HSTS).not.toMatch(/includeSubDomains|preload/);

    // Configured for HTTPS but this hop was plain: a proxy misconfiguration,
    // not a reason to lock browsers to HTTPS for a year.
    const plainHop = new Headers();
    applySecurityHeaders(req("http://internal/login", { "x-forwarded-proto": "http" }), plainHop, https);
    expect(plainHop.has("Strict-Transport-Security")).toBe(false);

    // A plain-HTTP deployment never emits it, whatever the request says.
    const httpDeploy = new Headers();
    applySecurityHeaders(req("http://localhost:3000/login", { "x-forwarded-proto": "https" }), httpDeploy, "http://localhost:3000");
    expect(httpDeploy.has("Strict-Transport-Security")).toBe(false);
  });
});

describe("arrivedOverHttps", () => {
  it("reads the client-facing hop from X-Forwarded-Proto, else the URL", () => {
    expect(arrivedOverHttps(req("http://x/", { "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(arrivedOverHttps(req("http://x/", { "x-forwarded-proto": "http, https" }))).toBe(false);
    expect(arrivedOverHttps(req("https://x/"))).toBe(true);
    expect(arrivedOverHttps(req("http://x/"))).toBe(false);
  });
});
