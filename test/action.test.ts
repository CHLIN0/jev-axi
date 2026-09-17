import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without type declarations
import { countDiffFiles, renderReview, renderTriage, REVIEW_MARKER, trimJobLog } from "../action/lib.mjs";

const RUN = resolve(__dirname, "..", "action", "run.mjs");

const review = (verdict: string, files: object[]) => ({ diff: "stdin", verdict, kind: "feature (0.8)", scope: "focused (0.1 of 0..2)", files, usage: "100in/10out" });

describe("action rendering", () => {
  it("renders flagged files, escapes table cells, and warns on credentials", () => {
    const md = renderReview(
      review("block", [
        { file: "src/a|b.ts", "+/-": "+3/-1", risk: 1.6, band: "act", flags: "secrets,high-risk" },
        { file: "README.md", "+/-": "+1/-0", risk: 0.1, band: "act", flags: "-" },
      ]),
    );
    expect(md.startsWith(REVIEW_MARKER)).toBe(true);
    expect(md).toContain("⛔ jev-axi review: block");
    expect(md).toContain("**Kind:** feature · **Scope:** focused · 1 flagged of 2 files");
    expect(md).toContain("| `src/a\\|b.ts` | +3/-1 | 1.6 | secrets, high-risk |");
    expect(md).toContain("[!CAUTION]");
    expect(md).toContain("<summary>All 2 files</summary>");
  });

  it("renders triage results, failures to triage, and clean logs", () => {
    const md = renderTriage([
      { name: "test", triage: { root_cause: { line: 12, p: 0.9, text: "Error: `boom`" }, category: "test (0.9, act)", flaky: "0.1", severity: "total", context: ["11: a", "12: Error: boom"] } },
      { name: "lint", error: "no key" },
      { name: "build", triage: { log: "stdin (last 20 of 20 lines)", verdict: "no failure detected" } },
    ]);
    expect(md).toContain("#### ❌ test");
    expect(md).toContain("**Likely cause** (line 12, p=0.9): `Error: 'boom'`");
    expect(md).toContain("Could not triage: no key");
    expect(md).toContain("#### ✅ build");
  });

  it("trims job logs to the last error and strips timestamps and groups", () => {
    const log = [
      "2026-09-17T13:04:27.2466084Z ##[group]Run pnpm test",
      "2026-09-17T13:04:27.2466084Z FAIL test/a.test.ts",
      "2026-09-17T13:04:28.0000000Z ##[error]Process completed with exit code 1.",
      "2026-09-17T13:04:29.0000000Z Post job cleanup.",
    ].join("\n");
    expect(trimJobLog(log)).toBe("FAIL test/a.test.ts\n##[error]Process completed with exit code 1.");
    expect(countDiffFiles("diff --git a/x b/x\n+1\ndiff --git a/y b/y\n")).toBe(2);
  });
});

/** Fake GitHub API: serves a PR diff and records comment writes. */
async function fakeGitHub(existingComment: boolean) {
  const writes: { method: string; url: string; body: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/repos/o/r/pulls/7") {
      res.writeHead(200, { "content-type": "text/plain" }).end("diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+x\n");
    } else if (req.method === "GET" && url.startsWith("/repos/o/r/issues/7/comments")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(existingComment ? [{ id: 99, body: `${REVIEW_MARKER}\nold` }] : []));
    } else {
      writes.push({ method: req.method!, url, body });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ html_url: "https://github.com/o/r/pull/7#c" }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, writes, close: () => server.close() };
}

function runAction(envOverrides: Record<string, string>): Promise<{ code: number; stdout: string; outputs: string }> {
  const dir = mkdtempSync(join(tmpdir(), "jev-action-"));
  const outputs = join(dir, "outputs");
  writeFileSync(outputs, "");
  const env = { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: join(dir, "summary"), JEV_INPUT_GITHUB_TOKEN: "t", ...envOverrides };
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [RUN], { env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolveRun({ code: code ?? 1, stdout, outputs: readFileSync(outputs, "utf8") }));
  });
}

/** A stand-in for `jev-axi diff - --json --full` that returns a fixed verdict. */
function fakeJevAxi(verdict: string): string {
  const script = join(mkdtempSync(join(tmpdir(), "jev-fake-")), "jev.mjs");
  const out = review(verdict, [{ file: "x.js", "+/-": "+1/-0", risk: 1, band: "act", flags: verdict === "ok" ? "-" : "secrets" }]);
  // Stray output before the JSON must not break parsing.
  writeFileSync(script, `process.stdin.resume(); process.stdin.on("end", () => { console.log("npm warn something"); console.log(${JSON.stringify(JSON.stringify(out, null, 2))}); });`);
  return JSON.stringify([process.execPath, script]);
}

describe("action run", () => {
  it("reviews a pull request, updates its existing comment, and fails on a credential", async () => {
    const gh = await fakeGitHub(true);
    try {
      const r = await runAction({ GITHUB_API_URL: gh.url, JEV_INPUT_API_KEY: "k", JEV_INPUT_PR_NUMBER: "7", JEV_AXI_BIN: fakeJevAxi("block") });
      expect(r.code).toBe(1);
      expect(r.outputs).toContain("verdict=block");
      expect(r.outputs).toContain("flagged=1");
      expect(gh.writes).toHaveLength(1);
      expect(gh.writes[0]!.method).toBe("PATCH");
      expect(gh.writes[0]!.url).toBe("/repos/o/r/issues/comments/99");
    } finally {
      gh.close();
    }
  });

  it("creates a comment when none exists and passes on ok", async () => {
    const gh = await fakeGitHub(false);
    try {
      const r = await runAction({ GITHUB_API_URL: gh.url, JEV_INPUT_API_KEY: "k", JEV_INPUT_PR_NUMBER: "7", JEV_AXI_BIN: fakeJevAxi("ok") });
      expect(r.code).toBe(0);
      expect(gh.writes.map((w) => `${w.method} ${w.url}`)).toEqual(["POST /repos/o/r/issues/7/comments"]);
    } finally {
      gh.close();
    }
  });

  it("skips without failing when there is no api key", async () => {
    const r = await runAction({ JEV_INPUT_API_KEY: "" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("No api-key: skipped");
  });
});
