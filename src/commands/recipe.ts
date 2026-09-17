import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseArgs } from "../args.js";
import { evaluate, type QuestionMap } from "../client.js";
import { paths } from "../config.js";
import { validation } from "../errors.js";
import { answerRow, distributionRows } from "../format.js";
import { loadState, STATE_FLAGS } from "../state.js";
import { evalOptions, finish, thresholdsFrom, type Renderable } from "./common.js";

export const RECIPE_HELP = `usage: jev-axi recipe list | show <name> | run <name> [state flags] | new <name> [--project]
Reusable question sets in YAML. A recipe is one \`ask\` with saved questions, so a team writes its definition of
"risky PR" or "urgent ticket" once and every agent session uses it.
locations (project first): ./.jev-axi/recipes/<name>.yaml, then ~/.config/jev-axi/recipes/<name>.yaml (or your XDG/AppData config dir)
recipe file:
  description: one line
  questions:
    <id>: {type: choice|score|noul, instructions: "...", criteria: ...}
flags for new:
  --project            create it in ./.jev-axi/recipes to commit and share, instead of your personal directory
flags for run:
  --state/--text/--state-json  state (piped stdin when none given); --full for distributions
examples:
  jev-axi recipe new ticket-triage
  jev-axi recipe new release-risk --project
  cat ticket.txt | jev-axi recipe run ticket-triage
`;

interface Recipe {
  name: string;
  file: string;
  description: string;
  questions: QuestionMap;
}

function recipeDirs(): string[] {
  return [join(process.cwd(), ".jev-axi", "recipes"), join(paths.configDir(), "recipes")];
}

function listRecipes(): Recipe[] {
  const seen = new Map<string, Recipe>();
  for (const dir of recipeDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
      const name = basename(f).replace(/\.ya?ml$/, "");
      if (!seen.has(name)) seen.set(name, loadRecipe(join(dir, f), name));
    }
  }
  return [...seen.values()];
}

function loadRecipe(file: string, name: string): Recipe {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    throw validation(`recipe ${name} is not valid YAML: ${(e as Error).message}`, [`Edit ${file}`]);
  }
  const d = (doc ?? {}) as Record<string, unknown>;
  const questions = d["questions"];
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw validation(`recipe ${name} has no \`questions\` map`, [`Edit ${file}; see \`jev-axi recipe --help\``]);
  }
  for (const [id, q] of Object.entries(questions as Record<string, Record<string, unknown>>)) {
    if (!q || !["choice", "score", "noul"].includes(String(q["type"])) || !q["instructions"]) {
      throw validation(`recipe ${name}: question ${JSON.stringify(id)} needs type choice|score|noul and instructions`);
    }
  }
  return { name, file, description: String(d["description"] ?? ""), questions: questions as QuestionMap };
}

function findRecipe(name: string): Recipe {
  for (const dir of recipeDirs()) {
    for (const ext of [".yaml", ".yml"]) {
      const file = join(dir, `${name}${ext}`);
      if (existsSync(file)) return loadRecipe(file, name);
    }
  }
  const known = listRecipes().map((r) => r.name);
  throw validation(`recipe not found: ${name}`, [known.length ? `Known recipes: ${known.join(", ")}` : "Run `jev-axi recipe new <name>` to create one"]);
}

const TEMPLATE = (name: string) => `description: Triage an incoming message (edit me)
# Every question sees the same state. Ask narrow questions; combine answers in your code.
questions:
  category:
    type: choice
    instructions: What is the main request in the message?
    criteria:
      bug: Something is broken or producing errors
      billing: Charges, invoices, refunds, subscriptions
      feature: A request for new functionality
      other: None of the above
  urgent:
    type: noul
    instructions: Does the message convey urgency or time pressure?
  frustration:
    type: score
    instructions: How frustrated does the author appear?
    criteria:
      - Calm, matter-of-fact
      - Frustrated but civil
      - Very angry or using strong language
# run: cat message.txt | jev-axi recipe run ${name}
`;

export async function recipeCommand(args: string[]): Promise<Renderable> {
  const p = parseArgs(args, { ...STATE_FLAGS, "--project": "bool" }, "recipe");
  const [action, name] = p.positional;
  if (!action || action === "list") {
    const recipes = listRecipes();
    if (recipes.length === 0) {
      return finish(p, { recipes: "0 recipes found", locations: recipeDirs() }, [], ["Run `jev-axi recipe new <name>` to scaffold one"]);
    }
    return finish(
      p,
      { recipes: recipes.map((r) => ({ name: r.name, questions: Object.keys(r.questions).length, description: r.description || "-" })) },
      [],
      ["Run `jev-axi recipe run <name> --state <file>` to use one", "Run `jev-axi recipe show <name>` to see its questions"],
    );
  }
  if (!name) throw validation(`recipe ${action} needs a name`, ["jev-axi recipe run <name>"]);
  if (action === "show") {
    const r = findRecipe(name);
    return finish(p, { recipe: r.name, file: r.file, description: r.description || "-", questions: r.questions as unknown as Record<string, unknown> }, []);
  }
  if (action === "new") {
    // --project: ./.jev-axi/recipes, to commit and share with the team; otherwise the personal directory.
    const dir = recipeDirs()[p.bools["--project"] ? 0 : 1]!;
    const file = join(dir, `${name}.yaml`);
    if (existsSync(file)) return finish(p, { recipe: `${name} already exists (no-op)`, file }, [], [`Edit ${file}`]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, TEMPLATE(name));
    return finish(p, { recipe: `${name} created`, file }, [], [`Edit the questions in ${file}`, `Run \`cat message.txt | jev-axi recipe run ${name}\``]);
  }
  if (action === "run") {
    const r = findRecipe(name);
    const state = loadState(p);
    const t = thresholdsFrom(p);
    const res = await evaluate(state, r.questions, evalOptions(p, `recipe:${name}`));
    const ids = Object.keys(r.questions);
    const out: Record<string, unknown> = { recipe: name, answers: ids.map((id) => answerRow(id, res.answers[id]!, t)) };
    if (p.bools["--full"]) out["distributions"] = Object.fromEntries(ids.map((id) => [id, distributionRows(res.answers[id]!)]));
    return finish(p, out, [res], p.bools["--full"] ? [] : ["Add --full for per-option probabilities"]);
  }
  throw validation(`unknown recipe action ${JSON.stringify(action)}`, ["jev-axi recipe list | show <name> | run <name> | new <name>"]);
}
