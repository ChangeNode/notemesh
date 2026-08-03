import path from "node:path";
import fs from "node:fs";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const env = {
  get dataDir(): string {
    const dir = path.resolve(process.env.DATA_DIR ?? "./data");
    return dir;
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
    const explicit = process.env.BASE_URL;
    if (explicit) return explicit.replace(/\/$/, "");
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    }
    return "http://localhost:3000";
  },
};

export function ensureDataDirs() {
  for (const dir of [env.dataDir, env.vaultDir, env.obHomeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface OriginMismatch {
  configured: string;
  reachedAt: string;
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
