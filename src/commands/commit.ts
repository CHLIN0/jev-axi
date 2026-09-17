import { numberFlag, parseArgs } from "../args.js";
import { evaluate, type EvalResult, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { loadCommits } from "../git.js";
import { COMMIT_QUESTIONS, COMMIT_THRESHOLDS } from "../recipes/questions.js";
import { evalOptions, finish, type Renderable } from "./common.js";

export const COMMIT_HELP = `usage: jev-axi commit [--range <a..b>] [--limit N]
Check commit messages against their diffs: conventional format, message matches the change, focus, and subject quality.
Defaults to the last commit; one call per commit.
flags:
  --range <a..b>       commits to check, e.g. main..HEAD
  --limit <n>          max commits (default 10)
examples:
  jev-axi commit
  jev-axi commit --range main..HEAD
`;

export async function commitCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--range": "value", "--limit": "value" }, "commit");
  if (p.positional.length) throw validation(`unexpected argument ${JSON.stringify(p.positional[0])}`, ["Use --range <a..b>"]);
  const limit = numberFlag(p, "--limit", 10, 1, 100);
  const commits = loadCommits(p.values["--range"], limit);
  if (commits.length === 0) return finish(p, { commits: `0 commits in ${p.values["--range"]}` }, []);
  const results: EvalResult[] = [];
  const rows: Record<string, unknown>[] = [];
  let failures = 0;
  for (const c of commits) {
    const diff = c.diff.length > COMMIT_THRESHOLDS.diffChars ? `${c.diff.slice(0, COMMIT_THRESHOLDS.diffChars)}\n... (truncated, ${c.diff.length} chars total)` : c.diff;
    const r = await evaluate({ subject: c.subject, body: c.body, diff }, COMMIT_QUESTIONS, evalOptions(p, "commit"));
    results.push(r);
    const conventional = (r.answers["conventional"] as NoulAnswer).noul;
    const describes = (r.answers["describes_diff"] as NoulAnswer).noul;
    const focused = (r.answers["focused"] as ScoreAnswer).score;
    const quality = (r.answers["subject_quality"] as ScoreAnswer).score;
    const issues: string[] = [];
    if (conventional < COMMIT_THRESHOLDS.pass) issues.push("not-conventional");
    if (describes < COMMIT_THRESHOLDS.pass) issues.push("message-mismatch");
    if (focused >= 1.5) issues.push("unfocused");
    if (quality < 1) issues.push("vague-subject");
    if (issues.length) failures++;
    rows.push({ sha: c.sha, subject: oneLine(c.subject, 60), matches: round(describes, 2), quality: round(quality), issues: issues.join(",") || "ok" });
  }
  const help: string[] = [];
  if (failures) help.push("message-mismatch means the message does not describe the diff's main change; unfocused means several unrelated changes");
  return finish(p, { range: p.values["--range"] ?? "last commit", count: `${failures} with issues of ${commits.length} commits`, commits: rows }, results, help);
}
