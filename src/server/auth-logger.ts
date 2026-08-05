/**
 * Better Auth's logger, with one self-inflicted warning filtered out.
 *
 * Its own kind of module so it can be tested without constructing a Better
 * Auth instance, which needs a database and an encryption key before it will
 * boot.
 */

/**
 * A warning Better Auth emits about its own migration output, on every boot.
 *
 * The oauth-provider plugin declares fields like oauthClient.redirectUris as
 * `string[]`. On SQLite, Better Auth's migration creates those columns as
 * `text` and stores JSON in them — but its start-up schema check only accepts a
 * `string[]` field when the column type contains "json", which no SQLite column
 * type does. So it creates a column it then complains about forever. The data
 * is fine: the values round-trip correctly.
 *
 * Suppressed rather than lived with because this is a deploy-it-yourself
 * template. Nine warnings at the top of a first deploy read as a broken
 * install, and a deployer has no way to tell they are noise.
 *
 * Matched narrowly. The table and field names are left open, since the set of
 * them depends on which plugins are enabled, but the expected and actual types
 * are pinned — so a real mismatch (a `string` field backed by an `integer`
 * column, say) still gets through.
 */
const SQLITE_ARRAY_COLUMN_WARNING =
  /^Field \w+ in table \w+ has a different type in the database\. Expected (string|number)\[\] but got TEXT\.$/i;

export function isSqliteArrayColumnWarning(level: string, message: string): boolean {
  return level === "warn" && SQLITE_ARRAY_COLUMN_WARNING.test(message);
}

/** Matches the shape Better Auth prints by default, minus the TTY colours. */
export function formatAuthLog(level: string, message: string): string {
  return `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`;
}

export function authLog(
  level: "info" | "warn" | "error" | "debug",
  message: string,
  ...args: unknown[]
): void {
  if (isSqliteArrayColumnWarning(level, message)) return;
  const line = formatAuthLog(level, message);
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}
