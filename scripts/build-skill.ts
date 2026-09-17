/**
 * Maintains skills/jev-axi:
 *
 * - references/commands.md is GENERATED from the CLI's own command table and each
 *   command's `--help` text, so it cannot drift from the CLI.
 * - SKILL.md and references/questions.md are hand-written. This script validates
 *   them against the Agent Skills spec and Anthropic's authoring guidance
 *   (name format, description length and voice, body size, working links).
 *
 *   pnpm build:skill    regenerate references/commands.md, then validate
 *   pnpm check:skill    fail if commands.md is stale or validation fails (CI)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { HELP } from "../src/cli.js";
import { paths } from "../src/config.js";
import { COMMAND_TABLE } from "../src/commands/table.js";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "jev-axi");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const COMMANDS_MD = join(SKILL_DIR, "references", "commands.md");

function commandName(cmd: string): string | undefined {
  return /jev-axi (\w+)/.exec(cmd)?.[1];
}

/**
 * Some --help texts show the real config, stats, and cache locations, which differ per machine
 * and OS. Replace them with the documented Linux defaults so the generated file is identical
 * everywhere (and CI's drift check is meaningful).
 */
function portable(text: string): string {
  const swaps: [string, string][] = [
    [paths.usageLedger(), "~/.config/jev-axi/stats/usage.jsonl"],
    [paths.configFile(), "~/.config/jev-axi/config.json"],
    [paths.statsDir(), "~/.config/jev-axi/stats"],
    [paths.configDir(), "~/.config/jev-axi"],
    [paths.cacheDir(), "~/.cache/jev-axi"],
  ];
  let out = text;
  for (const [actual, display] of swaps.sort((a, b) => b[0].length - a[0].length)) out = out.split(actual).join(display);
  // Paths built with path.join use backslashes on Windows.
  return out.replace(/~\\\.config\\jev-axi\\recipes/g, "~/.config/jev-axi/recipes");
}

export function renderCommandsReference(): string {
  const names = COMMAND_TABLE.map(([, cmd]) => commandName(cmd)).filter((n): n is string => !!n);
  const extra = Object.keys(HELP).filter((n) => !names.includes(n));
  const all = [...names, ...extra];
  const toc = all.map((n) => `- [${n}](#${n})`).join("\n");
  const sections = all
    .map((n) => {
      const need = COMMAND_TABLE.find(([, cmd]) => commandName(cmd) === n)?.[0];
      const help = portable(HELP[n] ?? "").trimEnd();
      return `## ${n}\n\n${need ? `${need}.\n\n` : ""}\`\`\`\n${help}\n\`\`\``;
    })
    .join("\n\n");
  return `# jev-axi command reference

Generated from \`jev-axi <command> --help\` by scripts/build-skill.ts. Do not edit by hand.

Global flags accepted by every command: \`--json\` (machine-readable output), \`--full\`
(no truncation, full distributions), \`--model <name>\`, \`--no-cache\`, \`--act <p>\` and
\`--confirm <p>\` (band thresholds), \`--help\`.

## Contents

${toc}

${sections}
`;
}

interface Problem {
  file: string;
  message: string;
}

export function validateSkill(skillMd = readFileSync(SKILL_MD, "utf8"), skillDir = SKILL_DIR): Problem[] {
  const problems: Problem[] = [];
  const add = (message: string, file = "SKILL.md") => problems.push({ file, message });

  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skillMd.replace(/\r\n/g, "\n"));
  if (!fm) {
    add("missing YAML frontmatter delimited by --- lines");
    return problems;
  }
  let meta: Record<string, unknown>;
  try {
    meta = (parseYaml(fm[1]!) ?? {}) as Record<string, unknown>;
  } catch (e) {
    add(`frontmatter is not valid YAML: ${(e as Error).message}`);
    return problems;
  }
  const body = fm[2]!;

  const name = meta["name"];
  if (typeof name !== "string" || name.length === 0) add("name is required");
  else {
    if (name.length > 64) add(`name is ${name.length} chars; max 64`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) add("name must be lowercase letters, numbers, and single hyphens, not starting or ending with a hyphen");
    if (/anthropic|claude/.test(name)) add("name must not contain reserved words 'anthropic' or 'claude'");
    const dirName = skillDir.replace(/\/+$/, "").split(/[\\/]/).pop();
    if (name !== dirName) add(`name "${name}" must match its directory "${dirName}"`);
  }

  const description = meta["description"];
  if (typeof description !== "string" || description.trim().length === 0) add("description is required");
  else {
    if (description.length > 1024) add(`description is ${description.length} chars; max 1024`);
    if (/<\/?[a-zA-Z][^>]*>/.test(description)) add("description must not contain XML tags");
    if (/^\s*(I|I'm|You|We)\b/.test(description)) add("description should be written in third person (e.g. 'Ranks files...'), not first or second person");
    if (!/\bUse (when|before|for|whenever)\b/i.test(description)) add("description should say when to use the skill (e.g. 'Use when ...')");
  }

  const compatibility = meta["compatibility"];
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) add("compatibility must be a string of at most 500 chars");

  const known = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
  for (const key of Object.keys(meta)) if (!known.has(key)) add(`unknown frontmatter field "${key}"`);

  const lines = body.split("\n").length;
  if (lines > 500) add(`body is ${lines} lines; keep SKILL.md under 500 and move detail to references/`);

  for (const m of body.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
    const target = m[1]!;
    if (/^[a-z]+:/i.test(target)) continue; // external URL
    if (target.includes("\\")) add(`link "${target}" uses backslashes; use forward slashes`);
    if (target.split("/").length > 2) add(`link "${target}" is nested more than one level deep`);
    if (!existsSync(join(skillDir, target))) add(`link target "${target}" does not exist`);
  }
  return problems;
}

function main(): void {
  const check = process.argv.includes("--check");
  const expected = renderCommandsReference();
  const normalize = (s: string) => s.replace(/\r\n/g, "\n");
  let failed = false;

  if (check) {
    const current = existsSync(COMMANDS_MD) ? readFileSync(COMMANDS_MD, "utf8") : "";
    if (normalize(current) !== normalize(expected)) {
      console.error("skills/jev-axi/references/commands.md is stale; run `pnpm build:skill`");
      failed = true;
    }
  } else {
    mkdirSync(dirname(COMMANDS_MD), { recursive: true });
    writeFileSync(COMMANDS_MD, expected);
    console.log("wrote skills/jev-axi/references/commands.md");
  }

  const problems = validateSkill();
  for (const p of problems) console.error(`skills/jev-axi/${p.file}: ${p.message}`);
  if (problems.length) failed = true;
  else console.log("skill is valid");

  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
