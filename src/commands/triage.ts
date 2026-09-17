import { existsSync, readFileSync } from "node:fs";
import { numberFlag, parseArgs } from "../args.js";
import { bandForConfidence, bandForNoul } from "../bands.js";
import { evaluate, type ChoiceAnswer, type NoulAnswer, type ScoreAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { estimateTokens, MAX_CHOICE_OPTIONS, STATE_TOKEN_BUDGET } from "../items.js";
import { TRIAGE_DEFAULT_TAIL, TRIAGE_QUESTIONS } from "../recipes/questions.js";
import { isStdinTTY, readStdinSync } from "../stdin.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const TRIAGE_HELP = `usage: jev-axi triage [<log file>|-] [--tail N] [--context N]
Triage a build, test, or runtime log: the root-cause line, failure category, flaky-vs-real, and severity, in one call.
Only the last --tail lines are sent (errors cluster at the end); each line is capped so the request fits the budget.
flags:
  --tail <n>           lines from the end to analyze (default ${TRIAGE_DEFAULT_TAIL}, max ${MAX_CHOICE_OPTIONS})
  --context <n>        lines of context to show around the root-cause line (default 2)
examples:
  npm test 2>&1 | jev-axi triage
  jev-axi triage build.log --tail 120
`;

export async function triageCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--tail": "value", "--context": "value" }, "triage");
  const src = p.positional[0];
  if (p.positional.length > 1) throw validation(`unexpected argument ${JSON.stringify(p.positional[1])}`, ["triage takes one log file or stdin"]);
  const tail = numberFlag(p, "--tail", TRIAGE_DEFAULT_TAIL, 5, MAX_CHOICE_OPTIONS);
  const context = numberFlag(p, "--context", 2, 0, 20);
  let text: string;
  let label: string;
  if (src === undefined || src === "-") {
    if (isStdinTTY()) throw validation("triage needs a log file or piped stdin", ["npm test 2>&1 | jev-axi triage"]);
    text = readStdinSync();
    label = "stdin";
  } else {
    if (!existsSync(src)) throw validation(`file not found: ${src}`);
    text = readFileSync(src, "utf8");
    label = src;
  }
  const all = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  while (all.length && all[all.length - 1]!.trim() === "") all.pop();
  if (all.length === 0) throw validation(`${label} is empty`);
  const offset = Math.max(0, all.length - tail);
  let lines = all.slice(offset);
  // Fit the budget: cap each line so the window never exceeds the state budget.
  const perLine = Math.max(80, Math.floor((STATE_TOKEN_BUDGET * 4) / lines.length));
  lines = lines.map((l) => (l.length > perLine ? `${l.slice(0, perLine)}…` : l));
  const id = (i: number) => `L${String(offset + i + 1).padStart(5, "0")}`;
  const doc = lines.map((l, i) => `${id(i)}| ${l}`).join("\n");
  if (estimateTokens(doc) > STATE_TOKEN_BUDGET) throw validation("log window is too large for one request", ["Lower --tail"]);
  const t = thresholdsFrom(p);
  const r = await evaluate(doc, TRIAGE_QUESTIONS(lines.map((_, i) => id(i))), evalOptions(p, "triage"));
  const first = r.answers["first_error"] as ChoiceAnswer;
  const hasError = (r.answers["has_error"] as NoulAnswer).noul;
  const category = r.answers["category"] as ChoiceAnswer;
  const flaky = (r.answers["flaky"] as NoulAnswer).noul;
  const severity = r.answers["severity"] as ScoreAnswer;
  const lineNo = Number(first.choice.slice(1));
  const idx = lineNo - offset - 1;
  const from = Math.max(0, idx - context);
  const to = Math.min(lines.length, idx + context + 1);
  const sevLabel = ["none or warning", "partial failure", "total failure"][Math.min(2, Math.max(0, Math.round(severity.score)))];
  const out: Record<string, unknown> = {
    log: `${label} (last ${lines.length} of ${all.length} lines)`,
    has_error: `${round(hasError, 2)} (${bandForNoul(hasError, t)})`,
    category: `${category.choice} (${round(category.confidence)}, ${bandForConfidence(category.confidence, t)})`,
    severity: `${sevLabel} (${round(severity.score)} of 0..2)`,
    flaky: `${round(flaky, 2)} (${flaky >= 0.6 ? "likely environmental; retry first" : flaky <= 0.3 ? "likely a real bug" : "unclear"})`,
    root_cause: { line: lineNo, p: round(first.probabilities[first.choice] ?? 0, 2), text: oneLine(lines[idx] ?? "", 160) },
    context: lines.slice(from, to).map((l, i) => `${offset + from + i + 1}: ${l}`),
  };
  const alternatives = Object.entries(first.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(1, 3)
    .filter(([, pr]) => pr >= 0.1)
    .map(([k, pr]) => `${Number(k.slice(1))} (${round(pr, 2)})`);
  const help: string[] = [];
  if (hasError < 0.35) help.push("No genuine failure detected; the run may have succeeded");
  if (alternatives.length) help.push(`Other candidate root-cause lines: ${alternatives.join(", ")}`);
  if (offset > 0) help.push(`Run with --tail ${Math.min(MAX_CHOICE_OPTIONS, all.length)} to include earlier lines`);
  return finish(p, out, [r], help);
}
