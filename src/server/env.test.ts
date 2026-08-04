import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectOriginMismatch, env } from "./env";

// A server that boots before it has a public domain advertises OAuth URLs
// pointing at the wrong origin, and the failure surfaces client-side as an
// opaque issuer mismatch. This is the check that turns that into a sentence
// telling the operator to restart.

describe("detects a stale configured origin", () => {
  it("fires when reached at a domain the server doesn't know about", () => {
    expect(detectOriginMismatch("http://localhost:3000", "my-vault.up.railway.app")).toEqual({
      configured: "http://localhost:3000",
      reachedAt: "my-vault.up.railway.app",
    });
  });

  it("fires when the domain changed between deploys", () => {
    expect(
      detectOriginMismatch("https://old-name.up.railway.app", "new-name.up.railway.app"),
    ).toBeTruthy();
  });

  it("fires for a custom domain in front of a generated one", () => {
    expect(detectOriginMismatch("https://x.up.railway.app", "vault.example.com")).toBeTruthy();
  });
});

describe("stays quiet when everything is consistent", () => {
  it("does not fire when the host matches", () => {
    expect(detectOriginMismatch("https://my-vault.up.railway.app", "my-vault.up.railway.app")).toBe(
      null,
    );
  });

  it("ignores case differences in the host", () => {
    expect(detectOriginMismatch("https://My-Vault.up.railway.app", "my-vault.up.railway.app")).toBe(
      null,
    );
  });

  it("matches when both carry the same explicit port", () => {
    expect(detectOriginMismatch("http://localhost:3000", "localhost:3000")).toBe(null);
  });

  it("does nothing without a Host header", () => {
    expect(detectOriginMismatch("http://localhost:3000", null)).toBe(null);
    expect(detectOriginMismatch("http://localhost:3000", undefined)).toBe(null);
    expect(detectOriginMismatch("http://localhost:3000", "")).toBe(null);
  });
});

describe("ignores loopback traffic", () => {
  // Platform health checks hit the container on loopback while the service is
  // legitimately configured for a public domain. Flagging that would mean every
  // correctly-configured deployment showing a permanent false warning.
  it.each(["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:8080", "[::1]", "[::1]:3000"])(
    "does not fire for %s",
    (host) => {
      expect(detectOriginMismatch("https://my-vault.up.railway.app", host)).toBe(null);
    },
  );
});

describe("fails safe on malformed input", () => {
  it("returns null rather than throwing on an unparseable configured URL", () => {
    expect(detectOriginMismatch("not a url", "my-vault.up.railway.app")).toBe(null);
  });

  it("returns null rather than throwing on an empty configured URL", () => {
    expect(detectOriginMismatch("", "my-vault.up.railway.app")).toBe(null);
  });
});

// Which origin this server believes it is reachable at. It becomes the OAuth
// issuer, so a value that cannot be parsed doesn't degrade — it breaks the
// provider plugin at init and turns every subsequent request into a 500.
describe("baseUrl", () => {
  const saved = {
    BASE_URL: process.env.BASE_URL,
    RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN,
  };

  beforeEach(() => {
    delete process.env.BASE_URL;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers an explicit BASE_URL", () => {
    process.env.BASE_URL = "https://vault.example.com";
    process.env.RAILWAY_PUBLIC_DOMAIN = "ignored.up.railway.app";
    expect(env.baseUrl).toBe("https://vault.example.com");
  });

  it("strips a trailing slash", () => {
    process.env.BASE_URL = "https://vault.example.com/";
    expect(env.baseUrl).toBe("https://vault.example.com");
  });

  it("derives the origin from the Railway domain when BASE_URL is unset", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "my-vault.up.railway.app";
    expect(env.baseUrl).toBe("https://my-vault.up.railway.app");
  });

  it("ignores a template reference that resolved to a bare scheme", () => {
    // The regression this guard exists for. `https://${{ RAILWAY_PUBLIC_DOMAIN }}`
    // becomes exactly this when the service has no domain at resolve time, and
    // the string is truthy — so it used to win over the fallback.
    process.env.BASE_URL = "https://";
    process.env.RAILWAY_PUBLIC_DOMAIN = "my-vault.up.railway.app";
    expect(env.baseUrl).toBe("https://my-vault.up.railway.app");
  });

  it("still yields a parseable origin when there is nothing to fall back to", () => {
    process.env.BASE_URL = "https://";
    expect(env.baseUrl).toBe("http://localhost:3000");
    expect(() => new URL(env.baseUrl)).not.toThrow();
  });

  it.each(["", "   ", "https://", "http://", "my-vault.up.railway.app", "not a url"])(
    "falls back rather than trusting BASE_URL=%j",
    (value) => {
      process.env.BASE_URL = value;
      process.env.RAILWAY_PUBLIC_DOMAIN = "my-vault.up.railway.app";
      expect(env.baseUrl).toBe("https://my-vault.up.railway.app");
    },
  );

  it("ignores an empty Railway domain", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "";
    expect(env.baseUrl).toBe("http://localhost:3000");
  });

  it("defaults to localhost for local development", () => {
    expect(env.baseUrl).toBe("http://localhost:3000");
  });

  it("always returns something a URL parser accepts", () => {
    // Whatever the inputs, the issuer must be constructible — this is the
    // property whose violation took the whole server down.
    for (const [b, d] of [
      ["https://", ""],
      ["", "x.up.railway.app"],
      ["nonsense", "also nonsense://"],
      [undefined, undefined],
    ] as const) {
      if (b === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = b;
      if (d === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
      else process.env.RAILWAY_PUBLIC_DOMAIN = d;
      expect(() => new URL(env.baseUrl)).not.toThrow();
    }
  });
});
