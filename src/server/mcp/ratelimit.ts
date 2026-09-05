// Anonymous-abuse throttle for /api/mcp.
//
// Deliberately scoped to *failed* authentication only: a request carrying a
// valid API key or OAuth token is never counted, so a chatty agent making
// hundreds of legitimate tool calls a minute is unaffected. What this stops is
// an unauthenticated stranger probing the endpoint.

import crypto from "node:crypto";

export const AUTH_WINDOW_MS = 10 * 60 * 1000;
const WINDOW_MS = AUTH_WINDOW_MS;
const MAX_FAILURES = 20;

// Hard ceiling on what any of the maps below track. Expired entries go first;
// if a map is still full — a burst of live, distinct sources — the oldest
// goes, since a Map iterates in insertion order. A source evicted while still
// failing gets a fresh bucket and the same limit, so the ceiling costs
// accuracy only under a flood, where accuracy was never the point; what it
// buys is that memory cannot grow with the number of addresses an attacker
// can appear from (#56).
export const MAX_TRACKED = 10_000;

function insertBounded<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  expiresAt: (v: T) => number,
  now: number,
): void {
  if (map.size >= MAX_TRACKED && !map.has(key)) {
    for (const [k, v] of map) if (now >= expiresAt(v)) map.delete(k);
    while (map.size >= MAX_TRACKED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

interface Bucket {
  failures: number;
  resetAt: number;
}

// Module-level so it survives across requests in this process. In-memory by
// design: a restart clearing the counters is acceptable for abuse damping, and
// it keeps a DB write off every anonymous request.
const globalKey = "__mcpAuthFailures";
function buckets(): Map<string, Bucket> {
  const g = globalThis as any;
  if (!g[globalKey]) g[globalKey] = new Map<string, Bucket>();
  return g[globalKey];
}

// Only trust forwarding headers when we know we're behind a proxy that sets
// them. Locally (or on any direct-connect deployment) an attacker could
// otherwise supply x-forwarded-for themselves and get a fresh bucket per
// request, making the limit decorative.
function behindTrustedProxy(): boolean {
  return Boolean(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.TRUST_PROXY_HEADERS);
}

export function clientIp(request: Request): string {
  if (behindTrustedProxy()) {
    const fwd = request.headers.get("x-forwarded-for");
    if (fwd) {
      // Left-most entry is the original client; the proxy appends its own hops.
      const first = fwd.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = request.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  // No socket address is exposed to this handler; fall back to a single shared
  // bucket. That is intentionally conservative: worst case anonymous probing is
  // throttled globally, and authenticated traffic is exempt regardless.
  return "unknown";
}

export function authFailureBlock(ip: string): { blocked: boolean; retryAfterSeconds: number } {
  const b = buckets().get(ip);
  if (!b) return { blocked: false, retryAfterSeconds: 0 };
  const now = Date.now();
  if (now >= b.resetAt) {
    buckets().delete(ip);
    return { blocked: false, retryAfterSeconds: 0 };
  }
  if (b.failures < MAX_FAILURES) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000) };
}

export function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const map = buckets();
  const b = map.get(ip);
  if (!b || now >= b.resetAt) {
    insertBounded(map, ip, { failures: 1, resetAt: now + WINDOW_MS }, (v) => v.resetAt, now);
    return;
  }
  b.failures += 1;
}

// ---------------------------------------------------------------------------
// Credentials seen failing, by digest.
//
// Blocking a source used to change only the status code: every request from
// it was still authenticated in full, so the guessing went on at the same
// cost and only the answer differed. Now a blocked source is refused before
// any authentication work — but only for a credential this server has
// already judged and found wanting, or for a request carrying none. A
// credential it has never seen is always judged, so a valid client behind a
// blocked address (a shared NAT, or every request in the local test suite)
// is never turned away unverified. That is the tradeoff, chosen and named: a
// guesser who never repeats a credential still costs one verification per
// guess, and is answered 429 all the same. The raw credential is never stored.

const failedKey = "__mcpFailedCredentials";
function failedCredentials(): Map<string, number> {
  const g = globalThis as any;
  if (!g[failedKey]) g[failedKey] = new Map<string, number>();
  return g[failedKey];
}

function digest(credential: string): string {
  return crypto.createHash("sha256").update(credential).digest("hex");
}

export function noteFailedCredential(credential: string, now = Date.now()): void {
  insertBounded(failedCredentials(), digest(credential), now + WINDOW_MS, (v) => v, now);
}

export function credentialRecentlyFailed(credential: string, now = Date.now()): boolean {
  const map = failedCredentials();
  const key = digest(credential);
  const until = map.get(key);
  if (until === undefined) return false;
  if (now >= until) {
    map.delete(key);
    return false;
  }
  return true;
}

/**
 * Should this request be refused before authentication? Only when the source
 * is past its limit and the credential is one already seen failing, or there
 * is no credential to judge.
 */
export function shortCircuit(
  ip: string,
  credential: string | null,
  now = Date.now(),
): { blocked: boolean; retryAfterSeconds: number } {
  const b = authFailureBlock(ip);
  if (!b.blocked) return b;
  if (credential !== null && !credentialRecentlyFailed(credential, now)) {
    return { blocked: false, retryAfterSeconds: 0 };
  }
  return b;
}

// Requests that reached authentication, and requests refused before it. The
// ratio is what says whether the throttle bounds work rather than only
// changing the status code; the Security tab shows both.
const statsKey = "__mcpAuthStats";
function stats(): { attempts: number; shortCircuited: number } {
  const g = globalThis as any;
  if (!g[statsKey]) g[statsKey] = { attempts: 0, shortCircuited: 0 };
  return g[statsKey];
}
export function recordAuthAttempt(): void {
  stats().attempts += 1;
}
export function recordShortCircuit(): void {
  stats().shortCircuited += 1;
}

// Clearing on success keeps an operator who fat-fingered a key from staying
// blocked once they present a working credential.
export function clearAuthFailures(ip: string): void {
  buckets().delete(ip);
}

// Read-only view of the throttle for the Security tab. Counts only live
// buckets — expired ones are ignored rather than deleted, so a dashboard poll
// never mutates limiter state.
export function authFailureSnapshot(): {
  trackedSources: number;
  blockedSources: number;
  recentFailures: number;
  windowMinutes: number;
  maxFailures: number;
  /** Requests that reached authentication since boot. */
  authAttempts: number;
  /** Requests refused before authentication since boot. */
  shortCircuited: number;
  trackedCredentials: number;
  maxTracked: number;
} {
  const now = Date.now();
  let trackedSources = 0;
  let blockedSources = 0;
  let recentFailures = 0;
  for (const b of buckets().values()) {
    if (now >= b.resetAt) continue;
    trackedSources += 1;
    recentFailures += b.failures;
    if (b.failures >= MAX_FAILURES) blockedSources += 1;
  }
  let trackedCredentials = 0;
  for (const until of failedCredentials().values()) if (now < until) trackedCredentials += 1;
  return {
    trackedSources,
    blockedSources,
    recentFailures,
    windowMinutes: WINDOW_MS / 60_000,
    maxFailures: MAX_FAILURES,
    authAttempts: stats().attempts,
    shortCircuited: stats().shortCircuited,
    trackedCredentials,
    maxTracked: MAX_TRACKED,
  };
}

// ---------------------------------------------------------------------------
// Anonymous-volume throttle for /api/rpc.
//
// A different question from the one above, so a different bucket. On /api/mcp
// the thing worth counting is a *failed* credential, because there is a
// credential to guess. On /api/rpc there is not: the session cookie is opaque
// and validated by Better Auth, so an anonymous flood is a load problem rather
// than a guessing one. What is counted here is therefore requests without a
// session — whether they reach a public procedure or bounce off the gate with a
// 401.
//
// A request carrying a valid session is never counted. Throttling the operator
// on their own single-user server would be friction with nothing bought.
const ANON_WINDOW_MS = 10 * 60 * 1000;

// Deliberately loose. Finishing the wizard costs a handful of anonymous calls
// and a person cannot approach this; it exists to bound a flood, not to police
// ordinary use. Cheap to lower later, expensive to explain if a real setup ever
// trips it.
const MAX_ANON_REQUESTS = 300;

const anonKey = "__rpcAnonRequests";
function anonBuckets(): Map<string, Bucket> {
  const g = globalThis as any;
  if (!g[anonKey]) g[anonKey] = new Map<string, Bucket>();
  return g[anonKey];
}

export function anonRequestBlock(ip: string): { blocked: boolean; retryAfterSeconds: number } {
  const b = anonBuckets().get(ip);
  if (!b) return { blocked: false, retryAfterSeconds: 0 };
  const now = Date.now();
  if (now >= b.resetAt) {
    anonBuckets().delete(ip);
    return { blocked: false, retryAfterSeconds: 0 };
  }
  if (b.failures < MAX_ANON_REQUESTS) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.ceil((b.resetAt - now) / 1000) };
}

export function noteAnonRequest(ip: string): void {
  const now = Date.now();
  const map = anonBuckets();
  const b = map.get(ip);
  if (!b || now >= b.resetAt) {
    insertBounded(map, ip, { failures: 1, resetAt: now + ANON_WINDOW_MS }, (v) => v.resetAt, now);
    return;
  }
  b.failures += 1;
}

export const ANON_LIMIT = { max: MAX_ANON_REQUESTS, windowMs: ANON_WINDOW_MS };
