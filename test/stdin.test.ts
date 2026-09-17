import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const BIN = join(ROOT, "bin", "jev-axi.ts");

/** Run the CLI the way an agent harness does: non-interactive, stdin attached to /dev/null (or NUL). */
function runAgentStyle(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [TSX, BIN, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, TYPESAFE_API_KEY: "unused", XDG_CONFIG_HOME: join(cwd, ".cfg"), XDG_CACHE_HOME: join(cwd, ".cache") },
    timeout: 60_000,
  });
  return { out: r.stdout, code: r.status };
}

describe("empty stdin from agent harnesses", () => {
  it("diff reviews the git working tree instead of the empty stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const { out, code } = runAgentStyle(["diff"], dir);
    expect(code).toBe(0);
    expect(out).toContain("diff: working tree changes");
    expect(out).toContain("0 changed files");
  });

  it("commands needing input say what to pass instead of 'state is empty'", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-stdin-"));
    writeFileSync(join(dir, "placeholder.txt"), "x");
    const check = runAgentStyle(["check", "is it?"], dir);
    expect(check.code).toBe(2);
    expect(check.out).toContain("error: no state given");
    const triage = runAgentStyle(["triage"], dir);
    expect(triage.out).toContain("triage needs a file or piped input");
    const rank = runAgentStyle(["rank", "q"], dir);
    expect(rank.out).toContain("error: no items given");
  });
});
