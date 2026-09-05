import { afterEach, describe, expect, it } from "vitest";
import { allowedOrigins, originAllowed } from "./origin";

// The Origin check, case by case. It used to accept any Origin whose host
// matched the request's own Host, which a DNS-rebinding page satisfies by
// construction. Now it is an allowlist from the configured base URL and
// nothing else; these pin every row of that decision.

function req(headers: Record<string, string>): Request {
  return new Request("http://ignored.example/api/mcp", { method: "POST", headers });
}

const BASE = "https://notes.example.com";
const allowed = allowedOrigins(BASE);

describe("originAllowed", () => {
  it("allows a request with no Origin: that is every real connector", () => {
    expect(originAllowed(req({}), allowed)).toBe(true);
    expect(originAllowed(req({ host: "rebind.attacker.test" }), allowed)).toBe(true);
  });

  it("allows the configured origin, however the request names its host", () => {
    expect(originAllowed(req({ origin: BASE, host: "notes.example.com" }), allowed)).toBe(true);
    expect(originAllowed(req({ origin: "HTTPS://Notes.Example.com:443" }), allowed)).toBe(true);
  });

  it("refuses a rebinding page: attacker Origin and matching attacker Host", () => {
    const r = req({ origin: "http://rebind.attacker.test", host: "rebind.attacker.test" });
    expect(originAllowed(r, allowed)).toBe(false);
  });

  it("refuses a foreign Origin even with the real Host", () => {
    expect(originAllowed(req({ origin: "https://evil.example", host: "notes.example.com" }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: `${BASE}.evil.example` }), allowed)).toBe(false);
  });

  it("refuses the right host on the wrong scheme or port", () => {
    expect(originAllowed(req({ origin: "http://notes.example.com" }), allowed)).toBe(false);
    expect(originAllowed(req({ origin: "https://notes.example.com:8443" }), allowed)).toBe(false);
  });

  it("refuses what is not an origin at all", () => {
    // (A whitespace-only Origin is normalised to an empty header before the
    // code sees it, and reads as absent; browsers never send one.)
    for (const bad of ["null", "notes.example.com", "https://", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(originAllowed(req({ origin: bad }), allowed), bad).toBe(false);
    }
  });
});

describe("allowedOrigins", () => {
  it("is exactly the configured origin for a real hostname", () => {
    expect([...allowedOrigins("https://notes.example.com")]).toEqual(["https://notes.example.com"]);
    expect([...allowedOrigins("https://notes.example.com:443/some/path")]).toEqual(["https://notes.example.com"]);
  });

  it("treats the loopback names as one server in local development, port included", () => {
    expect([...allowedOrigins("http://localhost:3000")].sort()).toEqual(
      ["http://127.0.0.1:3000", "http://[::1]:3000", "http://localhost:3000"].sort(),
    );
    expect(allowedOrigins("http://127.0.0.1:3000").has("http://localhost:3000")).toBe(true);
    expect(allowedOrigins("http://127.0.0.1:3000").has("http://localhost:3001")).toBe(false);
  });

  it("is empty for an unusable base URL, so nothing is allowed by accident", () => {
    expect(allowedOrigins("https://").size).toBe(0);
    expect(originAllowed(req({ origin: "https://anything.example" }), allowedOrigins("https://"))).toBe(false);
  });
});

describe("the base URL it reads", () => {
  const saved = { BASE_URL: process.env.BASE_URL, RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("comes from Railway's public domain when BASE_URL is absent, as on the template", () => {
    // The previous check read process.env.BASE_URL directly, so on Railway —
    // where the base URL is derived — only the Host shortcut ever matched.
    delete process.env.BASE_URL;
    process.env.RAILWAY_PUBLIC_DOMAIN = "my-notes.up.railway.app";
    expect(originAllowed(req({ origin: "https://my-notes.up.railway.app" }))).toBe(true);
    expect(originAllowed(req({ origin: "https://other.up.railway.app", host: "other.up.railway.app" }))).toBe(false);
  });
});
