import { parseArgs } from "../args.js";
import { bandForConfidence } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalResult, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { validation } from "../errors.js";
import { round } from "../format.js";
import { isTestPath, loadDiff, parseDiff, type FileDiff } from "../git.js";
import { estimateTokens, STATE_TOKEN_BUDGET } from "../items.js";
import { DIFF_OVERALL, DIFF_PER_FILE, DIFF_THRESHOLDS } from "../recipes/questions.js";
import { isStdinTTY, readStdinSync } from "../stdin.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const DIFF_HELP = `usage: jev-cli diff [--staged | --range <a..b> | --file <patch> | -]
Review a diff before committing: per-file risk, missing tests, secrets, debug leftovers, plus overall scope and kind.
Defaults to unstaged working-tree changes. Files are chunked to the token budget; large patches are truncated to ${DIFF_THRESHOLDS.patchChars} chars.
flags:
  --staged             review the index (what \`git commit\` would include)
  --range <a..b>       review commits, e.g. main..HEAD
  --file <patch>       review a unified diff file; or pipe one on stdin
  --full               show every file, not only flagged ones
examples:
  jev-cli diff --staged
  jev-cli diff --range main..HEAD
  git diff HEAD~3 | jev-cli diff -
`;

interface FileVerdict {
  file: string;
  "+/-": string;
  risk: number;
  band: string;
  flags: string;
}

export async function diffCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--staged": "bool", "--range": "value", "--file": "value" }, "diff");
  const fromStdin = p.positional[0] === "-" || (p.positional.length === 0 && !p.bools["--staged"] && !p.values["--range"] && !p.values["--file"] && !isStdinTTY());
  if (p.positional.length > (fromStdin ? 1 : 0)) throw validation(`unexpected argument ${JSON.stringify(p.positional[fromStdin ? 1 : 0])}`, ["Use --staged, --range <a..b>, --file <patch>, or pipe a diff"]);
  const { text, label } = loadDiff({
    staged: p.bools["--staged"],
    range: p.values["--range"],
    file: p.values["--file"],
    stdin: fromStdin ? readStdinSync() : undefined,
  });
  const files = parseDiff(text);
  if (files.length === 0) {
    return finish(p, { diff: label, files: "0 changed files; nothing to review" }, [], ["Run `jev-cli diff --staged` for the index or `--range main..HEAD` for commits"]);
  }
  const t = thresholdsFrom(p);
  // When the diff carries test files, a source file's tests are probably among them, so the
  // per-file "no test in this patch" signal is weaker; require a stronger noul before flagging.
  const testFiles = files.filter((f) => isTestPath(f.path)).length;
  const needsTestFlag = testFiles > 0 ? DIFF_THRESHOLDS.flagWhenTestsPresent : DIFF_THRESHOLDS.flag;

  // Chunk files to the budget, truncating oversized patches.
  const prepared = files.map((f, i) => ({ id: `F${String(i + 1).padStart(3, "0")}`, f, patch: truncatePatch(f) }));
  const chunks: typeof prepared[] = [];
  let cur: typeof prepared = [];
  let tokens = 0;
  for (const item of prepared) {
    // Each file also carries five questions (~180 tokens of instructions).
    const t = estimateTokens(item.patch) + 200;
    if (cur.length && tokens + t > STATE_TOKEN_BUDGET) {
      chunks.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(item);
    tokens += t;
  }
  if (cur.length) chunks.push(cur);

  const results: EvalResult[] = [];
  const verdicts: FileVerdict[] = [];
  let overall: { scope?: ScoreAnswer; kind?: ChoiceAnswer } = {};
  for (const [ci, chunk] of chunks.entries()) {
    const state = Object.fromEntries(chunk.map((c) => [c.id, { path: c.f.path, patch: c.patch }]));
    const questions = Object.assign({}, ...chunk.map((c) => DIFF_PER_FILE(c.id)), ci === 0 ? DIFF_OVERALL : {});
    const r = await evaluate(state, questions, evalOptions(p, "diff"));
    results.push(r);
    if (ci === 0) overall = { scope: r.answers["scope"] as ScoreAnswer, kind: r.answers["kind"] as ChoiceAnswer };
    for (const c of chunk) {
      const risk = r.answers[`${c.id}.risk`] as ScoreAnswer;
      const noul = (k: string) => (r.answers[`${c.id}.${k}`] as NoulAnswer).noul;
      const flags: string[] = [];
      if (noul("secrets") >= DIFF_THRESHOLDS.flag) flags.push("secrets");
      if (!isTestPath(c.f.path) && noul("needs_test") >= needsTestFlag) flags.push("needs-test");
      if (noul("leftovers") >= DIFF_THRESHOLDS.flag) flags.push("leftovers");
      if (risk.score >= DIFF_THRESHOLDS.highRisk) flags.push("high-risk");
      verdicts.push({
        file: c.f.path + (c.patch.length < c.f.patch.length ? " (truncated)" : ""),
        "+/-": `+${c.f.added}/-${c.f.removed}`,
        risk: round(risk.score),
        band: bandForConfidence(risk.confidence, t),
        flags: flags.join(",") || "-",
      });
    }
  }
  verdicts.sort((a, b) => b.risk - a.risk);
  const flagged = verdicts.filter((v) => v.flags !== "-");
  const shown = p.bools["--full"] ? verdicts : flagged.length ? flagged : verdicts.slice(0, 5);
  const scopeLevel = overall.scope ? Math.min(2, Math.max(0, Math.round(overall.scope.score))) : 0;
  const scopeLabel = ["focused", "mostly focused", "several unrelated changes"][scopeLevel];
  const secretsHit = verdicts.some((v) => v.flags.includes("secrets"));
  const verdict = secretsHit ? "block" : flagged.length ? "review" : "ok";

  const out: Record<string, unknown> = {
    diff: label,
    verdict,
    kind: overall.kind ? `${overall.kind.choice} (${round(overall.kind.confidence)})` : "unknown",
    scope: overall.scope ? `${scopeLabel} (${round(overall.scope.score)} of 0..2)` : "unknown",
    count: `${flagged.length} flagged of ${files.length} files (${testFiles} test files)${chunks.length > 1 ? ` in ${chunks.length} calls` : ""}`,
    files: shown,
  };
  const help: string[] = [];
  if (secretsHit) help.push("A file appears to add a real credential; remove it before committing");
  if (flagged.some((v) => v.flags.includes("needs-test"))) help.push("needs-test: behavior changed with no test change in the diff");
  if (scopeLevel === 2) help.push("Consider splitting this into separate commits or PRs");
  if (!p.bools["--full"] && shown.length < verdicts.length) help.push(`Add --full to see all ${verdicts.length} files`);
  return finish(p, out, results, help);
}

function truncatePatch(f: FileDiff): string {
  const max = DIFF_THRESHOLDS.patchChars;
  if (f.patch.length <= max) return f.patch;
  return `${f.patch.slice(0, max)}\n... (truncated, ${f.patch.length} chars total)`;
}
