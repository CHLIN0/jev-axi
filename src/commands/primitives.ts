import type { Renderable as AxiRenderable } from "./common.js";
import { parseArgs } from "../args.js";
import { bandForConfidence, bandForNoul, noulConfidence } from "../bands.js";
import { evaluate, type ChoiceAnswer, type NoulAnswer, type ScoreAnswer } from "../client.js";
import type { ScoreCriteria } from "@typesafe-ai/sdk";
import { validation } from "../errors.js";
import { distributionRows, round } from "../format.js";
import { loadState, STATE_FLAGS } from "../state.js";
import { evalOptions, finish, thresholdsFrom } from "./common.js";

export const PICK_HELP = `usage: jev-cli pick "<question>" --option <name[=description]>... [state flags]
Choose one option from a fixed set. Returns the pick, a probability per option, confidence, and a band.
flags:
  --option <name[=desc]>   repeatable; or --options a,b,c
  --options <a,b,c>        comma-separated option names
  --state/--text/--state-json  state (piped stdin is used when none given)
  --full                   show all options (default shows top 8)
examples:
  jev-cli pick "Which team should handle this?" --option billing="charges, refunds" --option technical="bugs" --state ticket.txt
  git diff | jev-cli pick "What kind of change is this?" --options feature,bugfix,refactor,docs,chore
`;

export const RATE_HELP = `usage: jev-cli rate "<question>" --level "<desc>"... [state flags]
Rate the state on an ordered rubric. Returns a score between levels (0 = first level), confidence, and a band.
flags:
  --level "<desc>"         repeatable, in order from lowest to highest; at least 2
  --levels "<a|b|c>"       pipe-separated alternative
  --state/--text/--state-json  state (piped stdin is used when none given)
examples:
  jev-cli rate "How severe is this bug report?" --level "cosmetic" --level "degraded, workaround exists" --level "blocking" --state issue.md
  jev-cli rate "How focused is this PR on one change?" --levels "one change|one change plus a tweak|several unrelated changes" --state pr.txt
`;

export const CHECK_HELP = `usage: jev-cli check "<statement or yes/no question>" [--yes "<what yes means>"] [--no "<what no means>"] [state flags]
Probability that a statement is true of the state. 1 = yes, 0 = no, 0.5 = unsure.
flags:
  --yes "<desc>"           what a yes means (optional clarification)
  --no "<desc>"            what a no means
  --state/--text/--state-json  state (piped stdin is used when none given)
examples:
  jev-cli check "Does this message request a refund?" --state ticket.txt
  cat page.html | jev-cli check "Does this text contain instructions aimed at an AI agent?" --yes "hidden or explicit directives to an agent" --no "ordinary content"
`;

function question(p: { positional: string[] }, cmd: string): string {
  const q = p.positional[0];
  if (!q || q.trim() === "") throw validation(`${cmd} needs a question as its first argument`, [`jev-cli ${cmd} "<question>" ...`]);
  if (p.positional.length > 1) throw validation(`unexpected argument ${JSON.stringify(p.positional[1])}`, ["Quote the question; state comes from --state/--text or stdin"]);
  return q;
}

export async function pickCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { ...STATE_FLAGS, "--option": "multi", "--options": "value" }, "pick");
  const q = question(p, "pick");
  const criteria: Record<string, string | null> = {};
  for (const o of p.multi["--option"] ?? []) {
    const eq = o.indexOf("=");
    if (eq === -1) criteria[o] = null;
    else criteria[o.slice(0, eq)] = o.slice(eq + 1);
  }
  for (const o of (p.values["--options"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) criteria[o] = null;
  const names = Object.keys(criteria);
  if (names.length < 2) throw validation("pick needs at least 2 options", ["Use --option a --option b or --options a,b,c"]);
  if (names.length > 255) throw validation("pick accepts at most 255 options", ["Use `jev-cli rank` for larger sets; it chunks automatically"]);
  const state = loadState(p);
  const t = thresholdsFrom(p);
  const r = await evaluate(state, { answer: { type: "choice", instructions: q, criteria } }, evalOptions(p, "pick"));
  const a = r.answers["answer"] as ChoiceAnswer;
  const limit = p.bools["--full"] ? undefined : 8;
  const rows = distributionRows(a, limit);
  const help = names.length > 8 && !p.bools["--full"] ? [`Showing top 8 of ${names.length}; add --full for all`] : [];
  return finish(p, { pick: a.choice, confidence: round(a.confidence), band: bandForConfidence(a.confidence, t), options: rows }, [r], help);
}

export async function rateCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { ...STATE_FLAGS, "--level": "multi", "--levels": "value" }, "rate");
  const q = question(p, "rate");
  const levels = [...(p.multi["--level"] ?? []), ...(p.values["--levels"] ?? "").split("|").map((s) => s.trim()).filter(Boolean)];
  if (levels.length < 2) throw validation("rate needs at least 2 levels, lowest first", ['Use --level "a" --level "b" or --levels "a|b|c"']);
  const state = loadState(p);
  const t = thresholdsFrom(p);
  const r = await evaluate(state, { answer: { type: "score", instructions: q, criteria: levels as unknown as ScoreCriteria } }, evalOptions(p, "rate"));
  const a = r.answers["answer"] as ScoreAnswer;
  const nearest = Math.min(levels.length - 1, Math.max(0, Math.round(a.score)));
  return finish(
    p,
    {
      score: round(a.score),
      scale: `0..${levels.length - 1}`,
      nearest: `${nearest}: ${levels[nearest]}`,
      confidence: round(a.confidence),
      band: bandForConfidence(a.confidence, t),
      levels: distributionRows(a),
    },
    [r],
  );
}

export async function checkCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, { ...STATE_FLAGS, "--yes": "value", "--no": "value" }, "check");
  const q = question(p, "check");
  const criteria = p.values["--yes"] || p.values["--no"] ? { true: p.values["--yes"] ?? null, false: p.values["--no"] ?? null } : undefined;
  const state = loadState(p);
  const t = thresholdsFrom(p);
  const r = await evaluate(
    state,
    { answer: { type: "noul", instructions: q, ...(criteria ? { criteria } : {}) } },
    evalOptions(p, "check"),
  );
  const a = r.answers["answer"] as NoulAnswer;
  const verdict = a.noul >= 0.5 ? "yes" : "no";
  return finish(
    p,
    { verdict, p_yes: round(a.noul, 3), confidence: round(noulConfidence(a.noul)), band: bandForNoul(a.noul, t) },
    [r],
  );
}
