import path from "node:path";
import fs from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const env = {
  get dataDir(): string {
    return path.resolve(process.env.DATA_DIR ?? "./data");
  },
  get vaultDir(): string {
    return path.join(this.dataDir, "vault");
  },
  get obHomeDir(): string {
    return path.join(this.dataDir, "home");
  },
  get dbPath(): string {
    return path.join(this.dataDir, "app.sqlite");
  },
  get encryptionKey(): Buffer {
    const raw = required("ENCRYPTION_KEY").trim();
    // Require real 256-bit key material — 32 bytes as base64 or hex. This key
    // encrypts the stored Obsidian/vault passwords AND derives the session
    // secret, so a low-entropy passphrase (previously accepted and hashed)
    // would be offline-brute-forceable if the DB leaked. No passphrase path.
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, "hex");
    }
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
    throw new Error(
      "ENCRYPTION_KEY must be 32 random bytes, as base64 (`openssl rand -base64 32`) " +
        "or 64 hex chars (`openssl rand -hex 32`).",
    );
  },
  get baseUrl(): string {
    // BASE_URL wins, but only when it names an origin something can actually
    // parse. A Railway template reference like
    // `https://${{ RAILWAY_PUBLIC_DOMAIN }}` resolves to a bare "https://" when
    // the service has no domain yet — and that string is truthy, so without the
    // host check it would beat the fallback below and pin the OAuth issuer to a
    // value no URL parser accepts. The provider plugin then throws during async
    // init, which surfaces as an unhandled rejection at boot and a 500 on every
    // request afterwards. Falling through to the fallback degrades far better:
    // the origin ends up wrong but valid, and detectOriginMismatch() below says
    // so in plain language.
    const explicit = usableOrigin(process.env.BASE_URL);
    if (explicit) return explicit;
    const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
    const fromRailway = domain ? usableOrigin(`https://${domain}`) : null;
    if (fromRailway) return fromRailway;
    return "http://localhost:3000";
  },
};

// An absolute origin with a host, or null. Anything else — empty, whitespace, a
// bare scheme, a hostname with no scheme — is not usable as an issuer.
function usableOrigin(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    if (!new URL(trimmed).host) return null;
  } catch {
    return null;
  }
  return trimmed.replace(/\/$/, "");
}

/**
 * Links back to this deployment on Railway, when it is one.
 *
 * Railway injects both IDs into every deployment, so their presence is the
 * detection: absent means self-hosted, another container platform, or a local
 * run, and the dashboard shows nothing rather than a dead link.
 *
 * Both are returned together and gated together. `project` needs only the
 * project ID, but a panel offering half its links is worse than no panel — and
 * a deployment with one ID and not the other is not a shape Railway produces,
 * so treating it as neither costs nothing real.
 *
 * The IDs are encoded on the way in. Not a security boundary — an operator who
 * can set environment variables on their own server has easier things to do —
 * but they are external input being pasted into URLs an admin will click, and a
 * stray character should not silently reshape the path.
 */
export function railwayLinks(): { project: string; service: string } | null {
  const projectId = process.env.RAILWAY_PROJECT_ID?.trim();
  const serviceId = process.env.RAILWAY_SERVICE_ID?.trim();
  if (!projectId || !serviceId) return null;

  const project = `https://railway.com/project/${encodeURIComponent(projectId)}`;
  return { project, service: `${project}/service/${encodeURIComponent(serviceId)}/settings` };
}

export function ensureDataDirs() {
  for (const dir of [env.dataDir, env.vaultDir, env.obHomeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface OriginMismatch {
  configured: string;
  reachedAt: string;
}

export interface InsecureBaseUrl {
  configured: string;
  servedOver: string;
}

/**
 * Is this instance served over HTTPS while configured as http?
 *
 * Better Auth decides the session cookie's Secure flag from BASE_URL. Behind a
 * proxy that terminates TLS — which is every platform deployment — an http
 * BASE_URL therefore issues the cookie without Secure, and it will travel in
 * the clear on any hop that is not TLS. Nothing else notices: the app works
 * perfectly, which is what makes it worth detecting rather than leaving to be
 * spotted.
 *
 * The answer is deliberately not to force Secure on. Measured in Chromium: a
 * Secure cookie on a plain-http LAN address is neither stored nor sent, so
 * forcing it would take someone self-hosting at http://192.168.x.x from working
 * to unable to sign in at all. Loopback is exempt for the same reason in
 * reverse — browsers treat it as trustworthy, so http there is already fine.
 *
 * `forwardedProto` is used only to diagnose. It is caller-controlled, so it
 * must never decide whether a cookie is marked Secure — only whether to say
 * something looks wrong.
 */
export function detectInsecureBaseUrl(
  configuredBaseUrl: string,
  forwardedProto: string | null | undefined,
): InsecureBaseUrl | null {
  if (!forwardedProto) return null;
  // X-Forwarded-Proto accumulates left to right; the client-facing hop is
  // first, and only that one says how the browser actually connected.
  const proto = forwardedProto.split(",")[0]?.trim().toLowerCase();
  if (proto !== "https") return null;

  let url: URL;
  try {
    url = new URL(configuredBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) return null;

  return { configured: configuredBaseUrl, servedOver: proto };
}

// Did this instance boot before it had a public domain?
//
// better-auth freezes its issuer at module init from env.baseUrl, and process
// env vars never change for the life of a process — so a domain generated after
// the container started is invisible to the running server, and every OAuth URL
// it advertises points somewhere wrong. The symptom is an opaque client-side
// "issuer mismatch", so detect it and say so plainly instead.
//
// `host` is used only to *diagnose* the mismatch, never to mint or validate
// anything. A Host header is caller-controlled; trusting one for an issuer
// would be the actual vulnerability.
export function detectOriginMismatch(
  configuredBaseUrl: string,
  host: string | null | undefined,
): OriginMismatch | null {
  if (!host) return null;
  // Loopback hits on a deployed instance are health checks, not the operator.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)) return null;
  let configuredHost: string;
  try {
    configuredHost = new URL(configuredBaseUrl).host;
  } catch {
    return null;
  }
  if (host.toLowerCase() === configuredHost.toLowerCase()) return null;
  return { configured: configuredBaseUrl, reachedAt: host };
}
