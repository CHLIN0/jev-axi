import { AxiError, exitCodeForError, runAxiCli } from "axi-sdk-js";
import { encode } from "@toon-format/toon";
import { renderHelp, renderWithHelp, type Renderable } from "./commands/common.js";
import { VERSION } from "./version.js";
import { homeCommand } from "./commands/home.js";
import { ASK_HELP, askCommand } from "./commands/ask.js";
import { CHECK_HELP, checkCommand, PICK_HELP, pickCommand, RATE_HELP, rateCommand } from "./commands/primitives.js";
import { FILTER_HELP, filterCommand, RANK_HELP, rankCommand } from "./commands/batch.js";
import { FIND_HELP, findCommand } from "./commands/find.js";
import { DIFF_HELP, diffCommand } from "./commands/diff.js";
import { FILES_HELP, filesCommand } from "./commands/files.js";
import { TRIAGE_HELP, triageCommand } from "./commands/triage.js";
import { GUARD_HELP, guardCommand } from "./commands/guard.js";
import { COMMIT_HELP, commitCommand } from "./commands/commit.js";
import { RECIPE_HELP, recipeCommand } from "./commands/recipe.js";
import { STATS_HELP, statsCommand } from "./commands/stats.js";
export { COMMAND_TABLE } from "./commands/table.js";
import {
  CONFIG_HELP,
  configCommand,
  MODELS_HELP,
  modelsCommand,
  SETUP_HELP,
  setupCommand,
  USAGE_HELP,
  usageCommand,
} from "./commands/meta.js";

export const DESCRIPTION =
  "Fast calibrated judgments from TypeSafe's Jev model: pick, rate, check, rank, filter, and find over files or stdin. Prefer this over reading everything yourself when a snap decision will do.";

export const TOP_HELP = `usage: jev-axi <command> [args] [flags]
primitives[4]: pick, rate, check, ask
batch[3]: rank, filter, find
recipes[6]: diff, files, triage, guard, commit, recipe
meta[6]: (none)=status, models, usage, stats, config, setup
global flags:
  --json, --full, --model <name>, --no-cache, --act <p>, --confirm <p>, --help, -v/--version
state:
  --state <path|->, --text "<s>", --state-json '<json>'; piped stdin is used when none given
bands:
  act (confidence >= 0.75), confirm (>= 0.45), escalate (below). Noul confidence = |p - 0.5| * 2
examples:
  jev-axi check "Does this diff touch authentication?" --state diff.txt
  jev-axi pick "Which team?" --options billing,technical,sales --text "my card was charged twice"
  jev-axi files "add a --json flag to the list command"
  jev-axi diff --staged
  npm test 2>&1 | jev-axi triage
  curl -s <url> | jev-axi guard
  jev-axi usage --by day
`;

const HELP: Record<string, string> = {
  ask: ASK_HELP,
  pick: PICK_HELP,
  rate: RATE_HELP,
  check: CHECK_HELP,
  rank: RANK_HELP,
  filter: FILTER_HELP,
  find: FIND_HELP,
  diff: DIFF_HELP,
  files: FILES_HELP,
  triage: TRIAGE_HELP,
  guard: GUARD_HELP,
  commit: COMMIT_HELP,
  recipe: RECIPE_HELP,
  stats: STATS_HELP,
  models: MODELS_HELP,
  usage: USAGE_HELP,
  config: CONFIG_HELP,
  setup: SETUP_HELP,
};

type Cmd = (args: string[]) => Promise<Renderable>;
const wrap = (cmd: Cmd) => async (args: string[]) => {
  const out = await cmd(args);
  return typeof out === "string" ? out : renderWithHelp(out);
};

export function formatError(error: unknown): { output: string; exitCode: number } {
  const e = error instanceof AxiError ? error : new AxiError(error instanceof Error ? error.message : String(error), "UNKNOWN");
  return {
    output: [encode({ error: e.message, code: e.code }), renderHelp(e.suggestions)].filter(Boolean).join("\n") + "\n",
    exitCode: exitCodeForError(e),
  };
}

export async function main(argv = process.argv.slice(2), stdout?: { write: (chunk: string) => unknown }): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    packageName: "jev-axi",
    argv,
    ...(stdout ? { stdout } : {}),
    topLevelHelp: TOP_HELP,
    getCommandHelp: (command) => HELP[command],
    formatError,
    home: wrap(() => homeCommand()),
    commands: {
      ask: wrap(askCommand),
      pick: wrap(pickCommand),
      rate: wrap(rateCommand),
      check: wrap(checkCommand),
      rank: wrap(rankCommand),
      filter: wrap(filterCommand),
      find: wrap(findCommand),
      diff: wrap(diffCommand),
      files: wrap(filesCommand),
      triage: wrap(triageCommand),
      guard: wrap(guardCommand),
      commit: wrap(commitCommand),
      recipe: wrap(recipeCommand),
      stats: wrap(statsCommand),
      models: wrap(modelsCommand),
      usage: wrap(usageCommand),
      config: wrap(configCommand),
      setup: wrap(setupCommand),
    },
  });
}
