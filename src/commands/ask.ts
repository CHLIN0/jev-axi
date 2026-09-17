import type { Renderable as AxiRenderable } from "./common.js";
import { parseArgs } from "../args.js";
import { evaluate, type QuestionMap } from "../client.js";
import { validation } from "../errors.js";
import { answerRow, distributionRows } from "../format.js";
import { loadQuestions, loadState, STATE_FLAGS } from "../state.js";
import { evalOptions, finish, thresholdsFrom } from "./common.js";

export const ASK_HELP = `usage: jev-cli ask --questions <path|json> [--state <path|-> | --text "<s>" | --state-json '<json>'] [--full] [--json]
Send one state and any mix of choice/score/noul questions in a single call (speculative fan-out).
questions file shape: {"<id>": {"type": "choice|score|noul", "instructions": "...", "criteria": ...}}
flags:
  --questions <path|json>  required; JSON object keyed by question id
  --state <path|->         state text or JSON (.json files are parsed); - reads stdin (default when piped)
  --text "<s>"             inline state text
  --state-json '<json>'    inline JSON state
  --full                   include probability distributions per question
  --model <name>           default jev-latest (see \`jev-cli models\`)
  --act/--confirm <p>      band thresholds (default 0.75 / 0.45)
  --no-cache               skip the local response cache
  --json                   raw JSON output
examples:
  jev-cli ask --questions triage.json --state ticket.txt
  cat diff.txt | jev-cli ask --questions '{"risky":{"type":"noul","instructions":"Does this diff touch auth or payments?"}}'
`;

const FLAGS = { ...STATE_FLAGS, "--questions": "value" } as const;

export async function askCommand(args: string[]): Promise<AxiRenderable> {
  const p = parseArgs(args, FLAGS, "ask");
  const qSrc = p.values["--questions"];
  if (!qSrc) throw validation("--questions is required", ["jev-cli ask --questions <path|json> --state <path>"]);
  if (p.positional.length) throw validation(`unexpected argument ${JSON.stringify(p.positional[0])}`, ["State comes from --state/--text/--state-json, not positionals"]);
  const questions = loadQuestions(qSrc) as QuestionMap;
  if (Object.keys(questions).length === 0) throw validation("questions object is empty");
  const state = loadState(p);
  const t = thresholdsFrom(p);
  const r = await evaluate(state, questions, evalOptions(p, "ask"));
  const ids = Object.keys(questions);
  const answers = ids.map((id) => answerRow(id, r.answers[id]!, t));
  const out: Record<string, unknown> = { answers };
  if (p.bools["--full"]) {
    out["distributions"] = Object.fromEntries(ids.map((id) => [id, distributionRows(r.answers[id]!)]));
  }
  const help = p.bools["--full"] ? [] : ["Add --full for per-option probabilities"];
  return finish(p, out, [r], help);
}
