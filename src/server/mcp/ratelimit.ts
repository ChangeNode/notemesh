// Anonymous-abuse throttle for /api/mcp.
//
// Deliberately scoped to *failed* authentication only: a request carrying a
// valid API key or OAuth token is never counted, so a chatty agent making
// hundreds of legitimate tool calls a minute is unaffected. What this stops is
// an unauthenticated stranger probing the endpoint.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;

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
    map.set(ip, { failures: 1, resetAt: now + WINDOW_MS });
    return;
  }
  b.failures += 1;
  // Opportunistic cleanup so the map can't grow without bound.
  if (map.size > 5000) {
    for (const [k, v] of map) if (now >= v.resetAt) map.delete(k);
  }
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
  return {
    trackedSources,
    blockedSources,
    recentFailures,
    windowMinutes: WINDOW_MS / 60_000,
    maxFailures: MAX_FAILURES,
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
    map.set(ip, { failures: 1, resetAt: now + ANON_WINDOW_MS });
    return;
  }
  b.failures += 1;
}

export const ANON_LIMIT = { max: MAX_ANON_REQUESTS, windowMs: ANON_WINDOW_MS };
