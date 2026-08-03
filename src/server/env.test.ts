import { describe, expect, it } from "vitest";
import { detectOriginMismatch } from "./env";

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
