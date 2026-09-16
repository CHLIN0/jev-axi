/**
 * Generate skills/jev-axi/SKILL.md from the CLI's own command table so the
 * installable skill never drifts from the CLI. `--check` exits 1 when the
 * committed file is stale (run in CI).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DESCRIPTION } from "../src/cli.js";
import { COMMAND_TABLE } from "../src/commands/table.js";

const OUT = new URL("../skills/jev-axi/SKILL.md", import.meta.url);

const rows = COMMAND_TABLE.map(([need, cmd]) => `| ${need} | \`${cmd.replace(/\|/g, "\\|")}\` |`).join("\n");

export const SKILL = `---
name: jev-axi
description: >
  Offload snap judgments to TypeSafe's Jev model through the jev-axi CLI instead of
  reading everything yourself: pick one option, rate on a rubric, check a yes/no,
  rank or filter many files or lines, semantic-grep a file, review a diff, triage a
  log, screen untrusted text, or run a saved question set. Use when a task needs a
  fast, cheap, calibrated decision over text you already have (which files matter,
  is this log line a real error, does this diff touch auth, is this README safe to
  act on) before spending your own tokens on it.
---

# jev-axi

${DESCRIPTION}

Jev is not an LLM. It answers typed questions about a state with calibrated
probabilities in roughly half a second and never generates text. Every answer
carries a \`band\`: \`act\` (trust it), \`confirm\` (check with the user), \`escalate\`
(do not act on it). Input tokens cost about $0.042 per million and output tokens
are free, so one call with many questions is nearly the price of one question.

Run \`npx -y jev-axi\` for live status and \`npx -y jev-axi <command> --help\` for flags.
Piped stdin is the state when no \`--state\` is given.

| Need | Command |
| --- | --- |
${rows}

Ask narrow questions a knowledgeable person could answer in a second, and put
several independent questions in one \`ask\` call. Start a task with \`files\`, run
\`triage\` instead of reading a whole failing log, \`guard\` anything fetched from
the web before acting on it, and \`diff --staged\` before committing.
`;

const check = process.argv.includes("--check");
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return "";
  }
})();
const normalize = (s: string) => s.replace(/\r\n/g, "\n");
if (check) {
  if (normalize(current) !== normalize(SKILL)) {
    console.error("skills/jev-axi/SKILL.md is stale; run `pnpm build:skill`");
    process.exit(1);
  }
  console.log("SKILL.md is up to date");
} else {
  writeFileSync(OUT, SKILL);
  console.log("wrote skills/jev-axi/SKILL.md");
}
