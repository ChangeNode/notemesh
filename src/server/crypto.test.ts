import { describe, expect, it, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { encryptSecret, decryptSecret } from "./crypto";

// This is what protects the stored Obsidian account password and the git
// access token. AES-256-GCM is authenticated encryption, so the property worth
// testing is not just that it round-trips but that tampered ciphertext is
// rejected rather than decrypted into something plausible.

const KEY_HEX = "a".repeat(64);

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("round-trips secrets", () => {
  it("recovers the original value", () => {
    expect(decryptSecret(encryptSecret("hunter2"))).toBe("hunter2");
  });

  it("handles an empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("handles non-ASCII and emoji", () => {
    const secret = "pässwörd–✅🔐";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("handles a long value", () => {
    const secret = "x".repeat(10_000);
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("handles a value containing the field separator", () => {
    // The stored form is iv.ciphertext.tag — a plaintext full of dots must not
    // confuse the parser, since it is encrypted before splitting ever happens.
    expect(decryptSecret(encryptSecret("a.b.c.d.e"))).toBe("a.b.c.d.e");
  });
});

describe("does not leak the plaintext", () => {
  it("produces different ciphertext each time, so equal secrets aren't equal at rest", () => {
    // A fixed IV would make identical passwords identical in the database.
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("does not contain the plaintext", () => {
    expect(encryptSecret("verysecretvalue")).not.toContain("verysecretvalue");
  });
});

describe("rejects tampering", () => {
  function parts(stored: string) {
    const [iv, ct, tag] = stored.split(".");
    return { iv, ct, tag };
  }

  it("refuses modified ciphertext", () => {
    const { iv, ct, tag } = parts(encryptSecret("hunter2"));
    const bytes = Buffer.from(ct, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret([iv, bytes.toString("base64"), tag].join("."))).toThrow();
  });

  it("refuses a modified authentication tag", () => {
    const { iv, ct, tag } = parts(encryptSecret("hunter2"));
    const bytes = Buffer.from(tag, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret([iv, ct, bytes.toString("base64")].join("."))).toThrow();
  });

  it("refuses a modified IV", () => {
    const { iv, ct, tag } = parts(encryptSecret("hunter2"));
    const bytes = Buffer.from(iv, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret([bytes.toString("base64"), ct, tag].join("."))).toThrow();
  });

  it("refuses a malformed value with missing fields", () => {
    expect(() => decryptSecret("notencrypted")).toThrow(/Malformed/);
    expect(() => decryptSecret("aaa.bbb")).toThrow(/Malformed/);
  });

  it("refuses an empty stored value", () => {
    expect(() => decryptSecret("")).toThrow(/Malformed/);
  });
});

describe("is bound to the encryption key", () => {
  it("cannot decrypt with a different key", () => {
    // The documented consequence of rotating ENCRYPTION_KEY: stored credentials
    // become unreadable rather than silently returning garbage.
    const stored = encryptSecret("hunter2");
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("accepts a base64 key as well as hex", () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect(decryptSecret(encryptSecret("hunter2"))).toBe("hunter2");
  });

  it("refuses key material that isn't 32 bytes", () => {
    // A passphrase would be brute-forceable offline if the database leaked.
    process.env.ENCRYPTION_KEY = "correct horse battery staple";
    expect(() => encryptSecret("x")).toThrow(/32 random bytes/);
  });

  it("refuses a missing key outright", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret("x")).toThrow(/ENCRYPTION_KEY/);
  });
});
