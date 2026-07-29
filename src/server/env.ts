import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";

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
  get setupToken(): string {
    return required("SETUP_TOKEN");
  },
  get encryptionKey(): Buffer {
    const raw = required("ENCRYPTION_KEY");
    // Accept exact 32-byte base64 keys, or any sufficiently long random
    // string (e.g. Railway's generated secrets), derived via SHA-256.
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
    if (raw.length >= 16) {
      return createHash("sha256").update(raw).digest();
    }
    throw new Error("ENCRYPTION_KEY must be at least 16 characters of random data");
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
