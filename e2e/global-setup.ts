import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startSeeded } from "./server";

/**
 * A stand-in `ob` that never exits.
 *
 * The seeded instance uses the Obsidian backend, and with no binary present the
 * supervisor fails immediately and sits in backoff — so the browser tests only
 * ever saw a broken daemon, and any control whose behaviour depends on a
 * *running* one could not be exercised at all. Sync Now is one: it has to be
 * absent while continuous sync holds the vault lock.
 *
 * OB_BIN is a supported override rather than a test-only hook; the unit tests
 * drive the same seam.
 */
function fakeObDaemon(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notemesh-e2e-ob-"));
  const script = path.join(dir, "ob");
  // Prints a line the activity parser recognises, then blocks the way
  // `sync --continuous` does. sync-status answers with JSON so the vault does
  // not read as unconfigured, and anything else exits cleanly.
  //
  // The trap and the one-second sleeps are what make Stop Sync work: a shell
  // waiting on a long foreground command does not act on SIGTERM until that
  // command returns, so `sleep 3600` would keep the fake daemon alive for an
  // hour after being asked to stop, and the supervisor would never reach
  // "stopped".
  fs.writeFileSync(
    script,
    `#!/bin/sh
trap 'exit 0' TERM INT
case "$1" in
  sync)
    echo "Starting sync"
    echo "Fully synced"
    while true; do sleep 1; done
    ;;
  sync-status) echo '{"vaultName":"E2E Vault","state":"synced"}' ;;
  # Enough of the account-facing surface to drive the wizard's Obsidian path in
  # a browser. Without sync-list-remote the vault step cannot render at all, so
  # that half of setup had no browser coverage.
  sync-list-remote) echo '{"vaults":[{"id":"v1","name":"E2E Vault","region":"us"}]}' ;;
  login) echo "Logged in." ;;
  sync-setup) echo "Sync configured." ;;
  sync-config) echo "Configuration updated." ;;
  *) : ;;
esac
exit 0
`,
  );
  fs.chmodSync(script, 0o755);
  return script;
}

export default async function globalSetup() {
  await startSeeded({ OB_BIN: fakeObDaemon() });
}
