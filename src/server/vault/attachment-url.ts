import crypto from "node:crypto";
import { env } from "../env";

/**
 * Short-lived signed URLs for attachments too large to return inline.
 *
 * `read_attachment` caps inline base64 at 1 MB, which leaves most photographs
 * visible only as a filename and a size. A signed URL is the retrieval half of
 * the answer: something the operator (or their browser) can open, without
 * putting a bearer token in a URL.
 *
 * Worth being precise about what it is not. A URL in a tool result does not let
 * the *model* see the image — MCP clients do not fetch links out of tool
 * output. This is "give me that file", not "look at this".
 *
 * The signature covers the expiry as well as the path, so neither can be edited
 * without invalidating it. The key is derived from ENCRYPTION_KEY under its own
 * label, the same separation authSecret() uses: one secret in the deployment,
 * distinct keys per purpose, so a signature can never be mistaken for a session
 * token or vice versa.
 */

// Short on purpose. These URLs land in model context, in tool logs, and in
// shell history; a link that stops working quickly is worth more here than one
// that is convenient. Nothing needs revoking at this lifetime.
export const ATTACHMENT_URL_TTL_MS = 15 * 60 * 1000;

function signingKey(): Buffer {
  return crypto.createHash("sha256").update(env.encryptionKey).update("attachment-url").digest();
}

/**
 * HMAC over expiry and path together.
 *
 * The expiry goes first and is followed by a newline, which a path cannot
 * contain — so there is exactly one way to split the signed string, and no
 * pair of (path, exp) values can produce the same input as another.
 */
function sign(relPath: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(`${expiresAt}\n${relPath}`)
    .digest("hex");
}

export function signAttachmentUrl(
  relPath: string,
  now: number = Date.now(),
): { url: string; expiresAt: number } {
  const expiresAt = now + ATTACHMENT_URL_TTL_MS;
  const query = new URLSearchParams({
    path: relPath,
    exp: String(expiresAt),
    sig: sign(relPath, expiresAt),
  });
  return { url: `${env.baseUrl}/api/attachment?${query}`, expiresAt };
}

export type UrlVerdict = { ok: true } | { ok: false; reason: "expired" | "invalid" };

export function verifyAttachmentUrl(
  relPath: string | null,
  exp: string | null,
  sig: string | null,
  now: number = Date.now(),
): UrlVerdict {
  if (!relPath || !exp || !sig) return { ok: false, reason: "invalid" };

  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt)) return { ok: false, reason: "invalid" };

  // Signature first, expiry second. Checking expiry on an unverified value
  // would answer questions about strings nobody signed.
  const expected = sign(relPath, expiresAt);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return { ok: false, reason: "invalid" };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };

  if (now >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Content types a browser will execute if it renders them from our own origin.
 *
 * This route is unauthenticated by necessity — a browser opening the link
 * carries no bearer token — and it serves files that arrived from a synced
 * vault, which is to say from anywhere. An `.svg` handed back as image/svg+xml
 * can run script on the origin holding the admin session cookie, so these are
 * served as an opaque download instead of by their real type.
 */
const SCRIPT_CAPABLE = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/pdf",
]);

export function safeContentType(mimeType: string): string {
  return SCRIPT_CAPABLE.has(mimeType) ? "application/octet-stream" : mimeType;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Quotes, backslashes and control characters would let a vault filename break
 * out of the quoted string and inject header parameters.
 */
export function dispositionFilename(relPath: string): string {
  const base = relPath.split("/").pop() ?? "attachment";
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}
