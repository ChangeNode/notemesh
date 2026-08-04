// Minimal structured audit log for security-relevant events (no secrets).
//
// Its own module rather than part of auth.ts so that modules auth.ts itself
// depends on can record events without an import cycle.
export function audit(event: string, detail: Record<string, unknown> = {}) {
  try {
    console.log(JSON.stringify({ audit: event, ts: new Date().toISOString(), ...detail }));
  } catch {
    console.log(`audit ${event}`);
  }
}
