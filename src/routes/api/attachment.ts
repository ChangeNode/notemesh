import fs from "node:fs";
import type { APIEvent } from "@solidjs/start/server";
import { attachmentMeta } from "~/server/vault/notes";
import { VaultPathError } from "~/server/vault/paths";
import {
  dispositionFilename,
  safeContentType,
  verifyAttachmentUrl,
} from "~/server/vault/attachment-url";

/**
 * Fetch an attachment by signed URL.
 *
 * Unauthenticated by necessity: a browser following one of these links carries
 * no bearer token, and putting a real credential in a URL — where it would land
 * in history, logs and model context — would be worse than the problem it
 * solved. The signature is the credential, it covers the path and the expiry
 * together, and it lasts fifteen minutes.
 *
 * The signature is not, however, permission to skip anything. The path is
 * resolved through attachmentMeta exactly as a tool call would resolve it, so
 * traversal, symlinks, dot-directories and LFS pointers are refused here on
 * their own merits. A valid signature over a bad path is still a bad path — and
 * signing is the one step in this system that could otherwise be argued into
 * standing in for the guards.
 */
function refuse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function GET(event: APIEvent) {
  const url = new URL(event.request.url);
  const relPath = url.searchParams.get("path");
  const verdict = verifyAttachmentUrl(
    relPath,
    url.searchParams.get("exp"),
    url.searchParams.get("sig"),
  );

  if (!verdict.ok) {
    // Expiry is worth distinguishing — it is the one failure with an obvious
    // remedy, and saying "ask for a fresh link" beats a flat refusal. A bad
    // signature says nothing beyond that it was bad.
    return verdict.reason === "expired"
      ? refuse(410, "This link has expired. Ask for the attachment again to get a fresh one.")
      : refuse(403, "Invalid or missing signature.");
  }

  let meta;
  try {
    meta = attachmentMeta(relPath!);
  } catch (e) {
    if (e instanceof VaultPathError) return refuse(404, e.message);
    console.error("[attachment] failed:", e);
    return refuse(500, "Could not read that attachment.");
  }

  const body = fs.readFileSync(meta.abs);
  return new Response(body, {
    headers: {
      // Never the file's own type when that type can execute. This origin holds
      // the admin session cookie, and vault files arrive from anywhere.
      "Content-Type": safeContentType(meta.mimeType),
      // Downloaded, not rendered — belt to the braces above.
      "Content-Disposition": dispositionFilename(meta.path),
      // No sniffing back to the type we just refused to honour.
      "X-Content-Type-Options": "nosniff",
      "Content-Length": String(body.byteLength),
      // The URL is short-lived by design; a cache holding the response would
      // outlive it.
      "Cache-Control": "private, no-store",
      // Nothing here should ever be framed or fetched cross-origin.
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
