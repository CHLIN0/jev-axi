import { numberFlag, parseArgs } from "../args.js";
import { bandForNoul } from "../bands.js";
import { evaluate, type ChoiceAnswer, type EvalResult, type NoulAnswer } from "../client.js";
import { validation } from "../errors.js";
import { oneLine, round } from "../format.js";
import { chunkItems, gatherItems, itemsState, type Item } from "../items.js";
import { FILES_QUESTIONS } from "../recipes/questions.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const FILES_HELP = `usage: jev-axi files "<task>" [dirs|paths]... [--top N] [--preview CHARS]
Which files would a developer open or change for a task. Ranks every source file under the given dirs (default: .)
by the start of its contents; run this before reading files yourself.
flags:
  --top <n>            rows to show (default 8)
  --preview <chars>    text per file sent to the model, after leading imports (default 700)
examples:
  jev-axi files "add a --json flag to the list command"
  jev-axi files "why does login redirect loop" src/ app/
`;

export async function filesCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { "--top": "value", "--preview": "value" }, "files");
  const task = p.positional[0];
  if (!task || task.trim() === "") throw validation("files needs a task description as its first argument", ['jev-axi files "<task>" [dirs...]']);
  const sources = p.positional.length > 1 ? p.positional.slice(1) : ["."];
  const top = numberFlag(p, "--top", 8, 1);
  const preview = numberFlag(p, "--preview", 700, 50);
  const items = gatherItems(sources, { preview });
  if (items.length < 2) throw validation(`only ${items.length} file(s) found under ${sources.join(", ")}`);
  const t = thresholdsFrom(p);
  const chunks = chunkItems(items);
  const results: EvalResult[] = [];
  const scored: { item: Item; p: number }[] = [];
  let existsMax = 0;
  for (const chunk of chunks) {
    const r = await evaluate(itemsState(chunk), FILES_QUESTIONS(task, chunk.map((i) => i.id)), evalOptions(p, "files"));
    results.push(r);
    const where = r.answers["where"] as ChoiceAnswer;
    const exists = (r.answers["exists"] as NoulAnswer).noul;
    existsMax = Math.max(existsMax, exists);
    const weight = chunks.length > 1 ? exists : 1;
    for (const item of chunk) scored.push({ item, p: (where.probabilities[item.id] ?? 0) * weight });
  }
  const norm = chunks.length > 1 ? scored.reduce((s, x) => s + x.p, 0) || 1 : 1;
  const ranked = scored.map((x) => ({ ...x, p: x.p / norm })).sort((a, b) => b.p - a.p);
  const shown = ranked.slice(0, top).filter((x) => x.p >= 0.005);
  const out: Record<string, unknown> = {
    task,
    relevant_file_exists: round(existsMax, 2),
    band: bandForNoul(existsMax, t),
    count: `${shown.length} shown of ${items.length} files${chunks.length > 1 ? ` in ${chunks.length} calls` : ""}`,
    files: shown.map((x, i) => ({ rank: i + 1, p: round(x.p, 3), file: x.item.label, preview: oneLine(x.item.text, 50) })),
  };
  const help: string[] = [];
  if (existsMax < 0.35) help.push("Low relevant_file_exists: the task may live outside these directories");
  if (shown.length) help.push(`Open the top file(s) first; run \`jev-axi find "<question>" <file>\` to locate the exact lines`);
  return finish(p, out, results, help);
}
