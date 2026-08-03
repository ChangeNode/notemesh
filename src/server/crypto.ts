import crypto from "node:crypto";
import { env } from "./env";

// AES-256-GCM with a random IV per value; output is iv.ciphertext.tag, base64.
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", env.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, enc, tag].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string): string {
  const parts = stored.split(".");
  // Check the shape, not the truthiness of each field: an empty plaintext
  // encrypts to an empty ciphertext, and rejecting that would make decrypt
  // refuse a value encrypt had just produced. The IV and tag are never empty.
  if (parts.length !== 3) throw new Error("Malformed encrypted value");
  const [ivB64, encB64, tagB64] = parts;
  if (!ivB64 || !tagB64) throw new Error("Malformed encrypted value");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    env.encryptionKey,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
