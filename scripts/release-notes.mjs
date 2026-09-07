// The changelog section for one version, for a GitHub Release's notes and as
// the release workflow's pre-flight check: a tag with no section is a tag
// that should not have been pushed.
//
//   node scripts/release-notes.mjs 1.2.0        → the section, on stdout
//   node scripts/release-notes.mjs v1.2.0       → same; the tag form is fine
//
// The section runs from its `## <version> — <date>` heading to the next
// `## ` heading. The heading itself is left out: the Release already has a
// title. Exits 1, saying so, when the version has no section or the section
// still says "Unreleased".
import fs from "node:fs";

const raw = process.argv[2];
if (!raw) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}
const version = raw.replace(/^v/, "");
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((l) => new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`).test(l));
if (start < 0) {
  const unreleased = lines.find((l) => l.startsWith(`## Unreleased (${version})`));
  console.error(
    unreleased
      ? `CHANGELOG.md still heads ${version} as unreleased; date it before tagging.`
      : `CHANGELOG.md has no section for ${version}.`,
  );
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end < 0) end = lines.length;
process.stdout.write(lines.slice(start + 1, end).join("\n").trim() + "\n");
