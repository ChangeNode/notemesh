import { env } from "./env";

/**
 * Browser security headers for every response (NM-SEC-012, #60).
 *
 * The signed attachment route has carried a locked-down policy since 1.0;
 * ordinary pages carried none. What these buy, in order of weight:
 *
 * - `frame-ancestors 'none'` and X-Frame-Options: the dashboard and the OAuth
 *   consent page cannot be framed by another origin, which is the setup for
 *   clickjacking a consent click.
 * - `object-src 'none'`, `base-uri 'none'`: no plugins, and no <base> tag to
 *   redirect relative URLs — the two CSP lines that matter with inline
 *   scripts still allowed.
 * - `form-action 'self'`: a form on this origin submits only to this origin.
 *   OAuth redirects to a client's callback are redirects, not form actions,
 *   so consent still completes.
 * - nosniff, a no-referrer policy, and a permissions policy denying the
 *   hardware the admin UI has no use for.
 *
 * Scripts are `'self' 'unsafe-inline'`. SolidStart hydrates with inline
 * scripts and this deployment has no nonce plumbing, so a strict script
 * policy would break every page; the honest version is to say so rather
 * than emit one that blocks nothing. The value is in the lines above it.
 *
 * HSTS is emitted only when the deployment is configured for HTTPS *and*
 * the request actually arrived over it, so a plain-HTTP deployment — local
 * development, a LAN box — never tells browsers to refuse HTTP for a year.
 * No includeSubDomains and no preload: a custom domain's other subdomains
 * are not this server's to speak for.
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const HSTS = "max-age=31536000";

/** True when this request came over HTTPS, as the client-facing hop saw it. */
export function arrivedOverHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Add the headers to a response's header set. A header the route already
 * chose — the attachment route's own CSP — is left alone, since a route that
 * set one knew something this does not.
 */
export function applySecurityHeaders(
  request: Request,
  headers: Headers,
  baseUrl: string = env.baseUrl,
): void {
  const setIfAbsent = (name: string, value: string) => {
    if (!headers.has(name)) headers.set(name, value);
  };
  setIfAbsent("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  setIfAbsent("X-Content-Type-Options", "nosniff");
  setIfAbsent("X-Frame-Options", "DENY");
  setIfAbsent("Referrer-Policy", "no-referrer");
  setIfAbsent("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (baseUrl.startsWith("https://") && arrivedOverHttps(request)) {
    setIfAbsent("Strict-Transport-Security", HSTS);
  }
}
