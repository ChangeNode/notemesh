import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_URL_TTL_MS,
  dispositionFilename,
  safeContentType,
  signAttachmentUrl,
  verifyAttachmentUrl,
} from "./attachment-url";

// The signature is the only credential on an otherwise open route, so what
// matters is that it cannot be edited around: not the path, not the expiry, and
// not by supplying something that merely looks right.

beforeEach(() => {
  process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  process.env.BASE_URL ??= "http://localhost:3000";
});

function partsOf(url: string) {
  const q = new URL(url).searchParams;
  return { path: q.get("path"), exp: q.get("exp"), sig: q.get("sig") };
}

describe("signing", () => {
  it("produces a URL carrying path, expiry and signature", () => {
    const { url, expiresAt } = signAttachmentUrl("Attachments/photo.jpg");
    const p = partsOf(url);
    expect(p.path).toBe("Attachments/photo.jpg");
    expect(Number(p.exp)).toBe(expiresAt);
    expect(p.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expires in fifteen minutes", () => {
    const now = 1_700_000_000_000;
    const { expiresAt } = signAttachmentUrl("a.png", now);
    expect(expiresAt - now).toBe(ATTACHMENT_URL_TTL_MS);
    expect(ATTACHMENT_URL_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("accepts its own signature", () => {
    const { url } = signAttachmentUrl("a.png");
    const p = partsOf(url);
    expect(verifyAttachmentUrl(p.path, p.exp, p.sig)).toEqual({ ok: true });
  });
});

describe("verification", () => {
  const valid = () => partsOf(signAttachmentUrl("Attachments/photo.jpg").url);

  it("refuses a different path under the same signature", () => {
    // The whole point: a signature for one file must not fetch another.
    const p = valid();
    expect(verifyAttachmentUrl("Attachments/secret.pdf", p.exp, p.sig)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses an extended expiry", () => {
    const p = valid();
    const later = String(Number(p.exp) + 60 * 60 * 1000);
    expect(verifyAttachmentUrl(p.path, later, p.sig)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a tampered signature", () => {
    const p = valid();
    const flipped = (p.sig![0] === "a" ? "b" : "a") + p.sig!.slice(1);
    expect(verifyAttachmentUrl(p.path, p.exp, flipped)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a signature of the wrong length without comparing it", () => {
    // timingSafeEqual throws on mismatched lengths, so this has to be handled
    // before the comparison rather than by it.
    const p = valid();
    expect(verifyAttachmentUrl(p.path, p.exp, "abc")).toEqual({ ok: false, reason: "invalid" });
    expect(verifyAttachmentUrl(p.path, p.exp, p.sig! + "00")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("refuses missing parameters", () => {
    const p = valid();
    expect(verifyAttachmentUrl(null, p.exp, p.sig).ok).toBe(false);
    expect(verifyAttachmentUrl(p.path, null, p.sig).ok).toBe(false);
    expect(verifyAttachmentUrl(p.path, p.exp, null).ok).toBe(false);
  });

  it("refuses a non-numeric expiry", () => {
    const p = valid();
    for (const junk of ["soon", "Infinity", "1e999", "", "9007199254740993"]) {
      expect(verifyAttachmentUrl(p.path, junk, p.sig).ok, junk).toBe(false);
    }
  });

  it("reports expiry separately, but only for a genuine signature", () => {
    const now = 1_700_000_000_000;
    const { url, expiresAt } = signAttachmentUrl("a.png", now);
    const p = partsOf(url);
    expect(verifyAttachmentUrl(p.path, p.exp, p.sig, expiresAt - 1)).toEqual({ ok: true });
    expect(verifyAttachmentUrl(p.path, p.exp, p.sig, expiresAt)).toEqual({
      ok: false,
      reason: "expired",
    });
    // An unsigned string is invalid, never "expired" — expiry is a statement
    // about something we issued.
    expect(verifyAttachmentUrl(p.path, p.exp, "0".repeat(64), expiresAt + 1)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("does not confuse a path/expiry pair with another one", () => {
    // Concatenation without a delimiter would let ("12" + "3.png") and
    // ("123" + ".png") sign the same bytes.
    const a = partsOf(signAttachmentUrl("3.png", 12).url);
    expect(verifyAttachmentUrl(".png", "123", a.sig, 0)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("serving safely", () => {
  it("refuses to hand back a content type a browser would execute", () => {
    // Served from the origin holding the admin session cookie, from files that
    // arrived over sync — so anything script-capable becomes a download.
    for (const t of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "application/xml",
      "text/javascript",
    ]) {
      expect(safeContentType(t), t).toBe("application/octet-stream");
    }
  });

  it("keeps ordinary media types", () => {
    for (const t of ["image/png", "image/jpeg", "audio/mpeg", "video/mp4"]) {
      expect(safeContentType(t), t).toBe(t);
    }
  });

  it("builds a Content-Disposition a filename cannot break out of", () => {
    const header = dispositionFilename('Attachments/we"ird\\name.png');
    // No bare quote or backslash survives into the quoted string.
    const quoted = header.match(/filename="([^"]*)"/)![1];
    expect(quoted).not.toMatch(/["\\]/);
    // Nothing that could start a new header.
    expect(header).not.toMatch(/[\r\n]/);
    // The real name still travels, escaped, for clients that read filename*.
    expect(header).toContain("filename*=UTF-8''");
  });

  it("keeps non-ASCII names readable through filename*", () => {
    const header = dispositionFilename("Attachments/café ☕.png");
    expect(header).toContain(encodeURIComponent("café ☕.png"));
    expect(header.match(/filename="([^"]*)"/)![1]).toMatch(/^[\x20-\x7e]*$/);
  });
});
