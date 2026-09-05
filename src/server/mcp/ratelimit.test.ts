import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  authFailureBlock,
  authFailureSnapshot,
  clearAuthFailures,
  clientIp,
  noteAuthFailure,
  noteAnonRequest,
  noteFailedCredential,
  credentialRecentlyFailed,
  shortCircuit,
  recordAuthAttempt,
  recordShortCircuit,
  AUTH_WINDOW_MS,
  MAX_TRACKED,
} from "./ratelimit";

// The throttle exists to damp anonymous probing of /api/mcp without ever
// standing in the way of an authorised client. Both halves of that are tested:
// that abuse gets blocked, and — more importantly — that legitimate traffic
// cannot be blocked no matter how much of it there is.

const MAX = authFailureSnapshot().maxFailures;

function reset() {
  for (const k of ["__mcpAuthFailures", "__rpcAnonRequests", "__mcpFailedCredentials", "__mcpAuthStats"]) {
    delete (globalThis as any)[k];
  }
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

// The maps have a ceiling, and a blocked source is refused before any
// authentication work — but only for a credential already seen failing, or
// none. Both halves of that, since the second is what keeps a valid client
// behind a blocked address from being turned away unverified.
describe("the maps are bounded", () => {
  const sources = () => (globalThis as any).__mcpAuthFailures as Map<string, unknown>;

  it("evicts the oldest live source at the ceiling, never growing past it", () => {
    for (let i = 0; i < MAX_TRACKED; i++) noteAuthFailure(`ip-${i}`);
    expect(sources().size).toBe(MAX_TRACKED);
    noteAuthFailure("ip-new");
    expect(sources().size).toBe(MAX_TRACKED);
    expect(sources().has("ip-0")).toBe(false);
    expect(sources().has("ip-new")).toBe(true);
    expect(authFailureSnapshot().maxTracked).toBe(MAX_TRACKED);
  });

  it("purges expired sources before evicting live ones", () => {
    noteAuthFailure("stale");
    (sources().get("stale") as { resetAt: number }).resetAt = Date.now() - 1;
    for (let i = 0; i < MAX_TRACKED - 1; i++) noteAuthFailure(`ip-${i}`);
    noteAuthFailure("ip-new");
    expect(sources().has("stale")).toBe(false);
    expect(sources().has("ip-0")).toBe(true);
    expect(sources().size).toBe(MAX_TRACKED);
  });

  it("bounds anonymous request tracking the same way", () => {
    for (let i = 0; i <= MAX_TRACKED; i++) noteAnonRequest(`ip-${i}`);
    const anon = (globalThis as any).__rpcAnonRequests as Map<string, unknown>;
    expect(anon.size).toBe(MAX_TRACKED);
    expect(anon.has("ip-0")).toBe(false);
  });
});

describe("refusing before authentication", () => {
  it("short-circuits a blocked source only for a known-bad credential, or none", () => {
    const ip = "1.2.3.4";
    expect(shortCircuit(ip, "bad").blocked).toBe(false);
    for (let i = 0; i < MAX; i++) noteAuthFailure(ip);
    expect(authFailureBlock(ip).blocked).toBe(true);
    // Blocked, but this credential has never been judged: it gets judged.
    expect(shortCircuit(ip, "bad").blocked).toBe(false);
    noteFailedCredential("bad");
    expect(shortCircuit(ip, "bad").blocked).toBe(true);
    expect(shortCircuit(ip, "bad").retryAfterSeconds).toBeGreaterThan(0);
    expect(shortCircuit(ip, "never-seen").blocked).toBe(false);
    expect(shortCircuit(ip, null).blocked).toBe(true);
    // Another source is not blocked, whatever it presents.
    expect(shortCircuit("5.6.7.8", "bad").blocked).toBe(false);
  });

  it("forgets a failed credential after the window, and never stores it raw", () => {
    const t0 = 1_800_000_000_000;
    noteFailedCredential("sk-live-secret-value", t0);
    expect(credentialRecentlyFailed("sk-live-secret-value", t0 + 1000)).toBe(true);
    expect(credentialRecentlyFailed("sk-live-other", t0 + 1000)).toBe(false);
    const keys = [...((globalThis as any).__mcpFailedCredentials as Map<string, number>).keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialRecentlyFailed("sk-live-secret-value", t0 + AUTH_WINDOW_MS + 1)).toBe(false);
  });

  it("bounds the credential map too", () => {
    for (let i = 0; i <= MAX_TRACKED; i++) noteFailedCredential(`cred-${i}`);
    expect(authFailureSnapshot().trackedCredentials).toBe(MAX_TRACKED);
    expect(credentialRecentlyFailed("cred-0")).toBe(false);
  });

  it("counts attempts and short-circuits for the Security tab", () => {
    recordAuthAttempt();
    recordAuthAttempt();
    recordShortCircuit();
    expect(authFailureSnapshot()).toMatchObject({ authAttempts: 2, shortCircuited: 1 });
  });
});
