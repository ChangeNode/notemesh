import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// The release workflow holds package, release and signing permissions and
// Docker Hub credentials, so what it runs must not be able to change under
// it. A tag can be moved; a commit cannot.

const dir = ".github/workflows";
const workflows = readdirSync(dir).filter((f) => f.endsWith(".yml")).map((f) => path.join(dir, f));

describe("the workflows", () => {
  it("pin every action to a commit SHA, with the version it was beside it", () => {
    for (const wf of workflows) {
      const uses = [...readFileSync(wf, "utf8").matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length, `${wf} uses actions`).toBeGreaterThan(0);
      for (const [, ref, rest] of uses) {
        expect(ref, `${wf}: ${ref}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
        expect(rest.trim(), `${wf}: ${ref} names its version`).toMatch(/^# v\d+\.\d+\.\d+$/);
      }
    }
  });

  it("fail CI on a high or critical production advisory, with a reviewed exception list", () => {
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/pnpm audit --prod --audit-level=high\s*$/m);
    expect(ci).not.toMatch(/pnpm audit[^\n]*\|\| true/);
    expect(readFileSync("pnpm-workspace.yaml", "utf8")).toMatch(/auditConfig:\n\s+ignoreCves:/);
  });

  it("have Dependabot moving the pins", () => {
    expect(readFileSync(".github/dependabot.yml", "utf8")).toMatch(/package-ecosystem: github-actions/);
  });
});
