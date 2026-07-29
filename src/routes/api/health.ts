import { json } from "@solidjs/router";
import { getSetting } from "~/server/db";

export function GET() {
  return json({
    ok: true,
    configured: getSetting("vault_configured") === "true",
  });
}
