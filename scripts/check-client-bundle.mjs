#!/usr/bin/env node
// Fail the build if server-only code reached the browser bundle.
//
// A route module that imports from src/server/ drags that module's whole import
// graph into the client build. When login.tsx imported a pure helper that
// happened to live in server/reset.ts, better-sqlite3 came with it, the module
// threw on load in the browser, and the sign-in component never mounted — so the
// form fell back to a native submit and failed silently, with no error shown
// because no JavaScript was running to show one.
//
// Nothing in the type system catches that: the import is valid, tsc is happy,
// the server build is fine, and the failure appears only in a browser. This is
// the cheapest place to notice it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".output/public/_build/assets";

// Markers that can only come from server-only modules.
//
// Minification renames identifiers, so string literals are all that survive —
// which means these have to be strings no client code would legitimately
// contain. Env-var names and log banners are a trap: the sign-in page prints
// "RESET_ADMIN_FLOW" and "ADMIN PASSWORD RESET ARMED" as instructions to the
// operator, so matching those flags the page's own copy. Package names and SQL
// are safe, because nothing in the browser has a reason to mention them.
const FORBIDDEN = [
  ["better-sqlite3", "the database driver — a server module leaked in"],
  ["obsidian-headless", "the ob CLI wrapper"],
  ["PRAGMA journal_mode", "server/db.ts — SQLite setup"],
  ["INSERT INTO settings", "server/db.ts — settings writes"],
  ["user.email=notemesh", "server/sync/git.ts — the commit identity"],
];

let files;
try {
  files = readdirSync(DIR).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`check-client-bundle: ${DIR} not found — run the build first.`);
  process.exit(1);
}

const hits = [];
for (const file of files) {
  const text = readFileSync(join(DIR, file), "utf8");
  for (const [needle, why] of FORBIDDEN) {
    if (text.includes(needle)) hits.push({ file, needle, why });
  }
}

if (hits.length) {
  console.error("\nServer-only code found in the client bundle:\n");
  for (const h of hits) console.error(`  ${h.file}\n    contains "${h.needle}" — ${h.why}\n`);
  console.error("A route or component is importing from src/server/. Move any pure");
  console.error("helper it needs into src/lib/, which is safe on both sides.\n");
  process.exit(1);
}

console.log(`check-client-bundle: ${files.length} client asset(s) clean.`);
