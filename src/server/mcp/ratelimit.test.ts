import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  authFailureBlock,
  authFailureSnapshot,
  clearAuthFailures,
  clientIp,
  noteAuthFailure,
} from "./ratelimit";

// The throttle exists to damp anonymous probing of /api/mcp without ever
// standing in the way of an authorised client. Both halves of that are tested:
// that abuse gets blocked, and — more importantly — that legitimate traffic
// cannot be blocked no matter how much of it there is.

const MAX = authFailureSnapshot().maxFailures;

function reset() {
  delete (globalThis as any).__mcpAuthFailures;
}

beforeEach(reset);
afterEach(() => {
  reset();
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/mcp", { headers });
}

describe("allows legitimate traffic", () => {
  it("does not block a source that has never failed", () => {
    expect(authFailureBlock("1.2.3.4").blocked).toBe(false);
  });

  it("does not block below the threshold", () => {
    for (let i = 0; i < MAX - 1; i++) noteAuthFailure("1.2.3.4");
    expect(authFailureBlock("1.2.3.4").blocked).toBe(false);
  });

  it("clears a source's history once it presents a working credential", () => {
    for (let i = 0; i < MAX; i++) noteAuthFailure("1.2.3.4");
    expect(authFailureBlock("1.2.3.4").blocked).toBe(true);
    clearAuthFailures("1.2.3.4");
    expect(authFailureBlock("1.2.3.4").blocked).toBe(false);
  });

  it("never counts successful calls, however many there are", () => {
    // A busy agent makes hundreds of authorised tool calls; none of them reach
    // noteAuthFailure, so the bucket stays empty.
    expect(authFailureSnapshot().recentFailures).toBe(0);
    expect(authFailureBlock("1.2.3.4").blocked).toBe(false);
  });

  it("keeps sources independent, so one abuser can't lock out anyone else", () => {
    for (let i = 0; i < MAX; i++) noteAuthFailure("9.9.9.9");
    expect(authFailureBlock("9.9.9.9").blocked).toBe(true);
    expect(authFailureBlock("1.2.3.4").blocked).toBe(false);
  });
});

describe("blocks anonymous probing", () => {
  it("blocks once the threshold is reached", () => {
    for (let i = 0; i < MAX; i++) noteAuthFailure("1.2.3.4");
    expect(authFailureBlock("1.2.3.4").blocked).toBe(true);
  });

  it("reports how long to wait", () => {
    for (let i = 0; i < MAX; i++) noteAuthFailure("1.2.3.4");
    const { retryAfterSeconds } = authFailureBlock("1.2.3.4");
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(authFailureSnapshot().windowMinutes * 60);
  });

  it("stays blocked as failures continue past the threshold", () => {
    for (let i = 0; i < MAX * 2; i++) noteAuthFailure("1.2.3.4");
    expect(authFailureBlock("1.2.3.4").blocked).toBe(true);
  });
});

describe("clientIp trusts forwarding headers only behind a known proxy", () => {
  it("ignores X-Forwarded-For when nothing guarantees a proxy set it", () => {
    // This is the security-critical half. If the header were trusted on a
    // direct-connect deployment, an attacker would forge a new one per request
    // and get an unlimited number of fresh buckets, making the limit decorative.
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe("unknown");
  });

  it("ignores X-Real-IP for the same reason", () => {
    expect(clientIp(req({ "x-real-ip": "6.6.6.6" }))).toBe("unknown");
  });

  it("falls back to a single shared bucket rather than failing open", () => {
    // Conservative on purpose: worst case anonymous probing is throttled
    // globally, and authorised traffic is exempt regardless.
    expect(clientIp(req())).toBe("unknown");
  });

  it("uses the header once a proxy is known to be in front", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe("6.6.6.6");
  });

  it("takes the left-most entry, which is the original client", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 10.0.0.1, 10.0.0.2" }))).toBe("6.6.6.6");
  });

  it("trusts the header automatically on Railway", () => {
    process.env.RAILWAY_PUBLIC_DOMAIN = "example.up.railway.app";
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6" }))).toBe("6.6.6.6");
  });

  it("still falls back when behind a proxy that sent no header", () => {
    process.env.TRUST_PROXY_HEADERS = "1";
    expect(clientIp(req())).toBe("unknown");
  });
});

describe("authFailureSnapshot", () => {
  it("reports nothing on a quiet instance", () => {
    expect(authFailureSnapshot()).toMatchObject({
      trackedSources: 0,
      blockedSources: 0,
      recentFailures: 0,
    });
  });

  it("counts tracked sources, failures and blocks", () => {
    noteAuthFailure("1.1.1.1");
    noteAuthFailure("1.1.1.1");
    for (let i = 0; i < MAX; i++) noteAuthFailure("2.2.2.2");
    const snap = authFailureSnapshot();
    expect(snap.trackedSources).toBe(2);
    expect(snap.recentFailures).toBe(2 + MAX);
    expect(snap.blockedSources).toBe(1);
  });

  it("does not mutate limiter state when read", () => {
    noteAuthFailure("1.1.1.1");
    authFailureSnapshot();
    authFailureSnapshot();
    expect(authFailureSnapshot().recentFailures).toBe(1);
  });
});
