// Entry point for the jev-axi GitHub Action. Dependency-free: Node built-ins and fetch only.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countDiffFiles, renderReview, renderTriage, REVIEW_MARKER, TRIAGE_MARKER, trimJobLog } from "./lib.mjs";

const env = process.env;
const input = (name, fallback = "") => (env[`JEV_INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? "").trim() || fallback;
const event = env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
const [owner, repo] = (env.GITHUB_REPOSITORY ?? "/").split("/");
const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
const MAX_TRIAGE_JOBS = 4;

const notice = (msg) => console.log(`::notice title=jev-axi::${msg}`);
const warning = (msg) => console.log(`::warning title=jev-axi::${msg}`);
const setOutput = (key, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${key}=${String(value).replace(/\r?\n/g, " ")}\n`);
const summary = (md) => (env.GITHUB_STEP_SUMMARY ? appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`) : console.log(md));

class GitHubError extends Error {
  constructor(status, body) {
    super(`GitHub API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

async function github(path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${input("github-token")}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jev-axi-action",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new GitHubError(res.status, await res.text());
  // Job logs redirect to plain text even when JSON is accepted, so parse by what came back.
  return (res.headers.get("content-type") ?? "").includes("json") ? res.json() : res.text();
}

/** Run jev-axi with --json. JEV_AXI_BIN (a JSON array of argv) overrides the npx invocation, for testing. */
function jevAxi(args, stdin) {
  const version = input("version") || JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
  const [cmd, ...pre] = env.JEV_AXI_BIN ? JSON.parse(env.JEV_AXI_BIN) : ["npx", "-y", `jev-axi@${version}`];
  const model = input("model");
  const r = spawnSync(cmd, [...pre, ...args, "--json", ...(model ? ["--model", model] : [])], {
    input: stdin,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // npx is a .cmd script on Windows, which needs a shell.
    shell: process.platform === "win32" && !env.JEV_AXI_BIN,
    env: { ...env, TYPESAFE_API_KEY: input("api-key") },
  });
  const out = (r.stdout ?? "").trim();
  if (r.status === 0) {
    // The JSON document starts at the first line that opens an object; tolerate stray output before it.
    const start = out.startsWith("{") ? 0 : out.indexOf("\n{") + 1;
    try {
      if (start >= 0) return JSON.parse(out.slice(start));
    } catch {
      // fall through
    }
  }
  throw new Error((out || r.stderr || r.error?.message || `exit ${r.status}`).split("\n").slice(0, 3).join(" "));
}

/** Create or update this action's comment on a pull request. */
async function upsertComment(number, marker, body) {
  try {
    let existing;
    for (let page = 1; page <= 10 && !existing; page++) {
      const comments = await github(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
      existing = comments.find((c) => c.body?.includes(marker));
      if (comments.length < 100) break;
    }
    const res = existing
      ? await github(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } })
      : await github(`/repos/${owner}/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
    setOutput("comment-url", res.html_url);
  } catch (error) {
    if (error.status === 403) warning("Could not comment: the token is read-only (pull requests from forks, or missing `pull-requests: write`). See the job summary.");
    else warning(`Could not comment: ${error.message}`);
  }
}

async function review() {
  const pr = event.pull_request ?? (input("pr-number") ? { number: Number(input("pr-number")) } : undefined);
  if (!pr) throw new Error("review mode needs a pull_request event or the pr-number input");
  let diff;
  try {
    diff = await github(`/repos/${owner}/${repo}/pulls/${pr.number}`, { accept: "application/vnd.github.v3.diff" });
  } catch (error) {
    if (error.status === 406 || error.status === 422) return notice(`Pull request #${pr.number} is too large for GitHub's diff API; skipped review.`);
    throw error;
  }
  const files = countDiffFiles(diff);
  if (files === 0) return notice("No changes to review.");
  const maxFiles = Number(input("max-files", "100"));
  if (files > maxFiles) return notice(`${files} changed files is over max-files (${maxFiles}); skipped review.`);

  const result = jevAxi(["diff", "-", "--full"], diff);
  const md = renderReview(result);
  summary(md);
  setOutput("verdict", result.verdict);
  setOutput("flagged", (result.files ?? []).filter((f) => f.flags !== "-").length);
  if (input("comment", "true") === "true") await upsertComment(pr.number, REVIEW_MARKER, md);
  const failOn = input("fail-on", "block");
  if ((failOn === "block" && result.verdict === "block") || (failOn === "review" && result.verdict !== "ok")) {
    console.log(`::error title=jev-axi::review verdict is ${result.verdict}`);
    process.exitCode = 1;
  }
}

async function triage() {
  const results = [];
  const logFile = input("log-file");
  let prNumber = event.pull_request?.number;
  if (logFile) {
    if (!existsSync(logFile)) throw new Error(`log-file not found: ${logFile}`);
    try {
      results.push({ name: logFile, triage: jevAxi(["triage", "-"], readFileSync(logFile, "utf8")) });
    } catch (error) {
      results.push({ name: logFile, error: error.message });
    }
  } else {
    const runId = input("run-id") || event.workflow_run?.id;
    if (!runId) throw new Error("triage mode needs log-file, run-id, or a workflow_run event");
    prNumber ??= event.workflow_run?.pull_requests?.[0]?.number;
    const { jobs } = await github(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const failed = jobs.filter((j) => j.conclusion === "failure");
    if (failed.length === 0) return notice(`No failed jobs in run ${runId}.`);
    for (const job of failed.slice(0, MAX_TRIAGE_JOBS)) {
      try {
        const log = await github(`/repos/${owner}/${repo}/actions/jobs/${job.id}/logs`, {});
        const step = job.steps?.find((s) => s.conclusion === "failure")?.name;
        const name = step ? `${job.name} › ${step}` : job.name;
        results.push({ name, triage: jevAxi(["triage", "-"], trimJobLog(log)) });
      } catch (error) {
        results.push({ name: job.name, error: error.message });
      }
    }
    if (failed.length > MAX_TRIAGE_JOBS) notice(`${failed.length} jobs failed; triaged the first ${MAX_TRIAGE_JOBS}.`);
  }
  const md = renderTriage(results);
  summary(md);
  const cause = results.find((r) => r.triage?.root_cause)?.triage.root_cause;
  setOutput("root-cause", cause ? cause.text : "");
  if (prNumber && input("comment", "true") === "true") await upsertComment(prNumber, TRIAGE_MARKER, md);
}

try {
  if (!input("api-key")) {
    notice("No api-key: skipped. Secrets are not passed to workflows triggered from forks; see the README for workflow_run.");
  } else {
    const mode = input("mode", "review");
    if (mode === "review") await review();
    else if (mode === "triage") await triage();
    else throw new Error(`unknown mode ${mode}; use review or triage`);
  }
} catch (error) {
  console.log(`::error title=jev-axi::${error.message}`);
  process.exitCode = 1;
}
