import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Marker so we only ever overwrite or remove files we installed. */
const MARKER = "<!-- installed by jev-axi setup agent -->";

const PROMPT = `${MARKER}
You explore a codebase to answer a question or locate the code a task needs, and report back
concisely. You do not edit files.

Use the jev-axi CLI (instructions preloaded from the jev-axi skill) to decide where to look,
then read only what you need:

1. If the task names something searchable (an identifier, error message, flag, route, or
   config key), start with grep or glob. Exact search beats ranking.
2. Otherwise run \`jev-axi files "<task in plain words>" <likely directories>\` to shortlist
   files; it also considers the repo's docs/. Open the top few, not everything.
3. In long files, use \`jev-axi find "<specific question>" <file> --context 3\` and read around
   the hit instead of reading the whole file.
4. For "find every place that..." questions, use \`jev-axi filter "<condition>" <dirs> --all\`
   rather than \`files\`, which picks one winner.
5. If jev-axi is unavailable (no key, not installed), continue with grep, glob, and reading.

Report: the direct answer first, then the files (with line numbers) that support it, then
anything you could not confirm. Keep it short; the caller will read the files it needs.`;

function agentFile(name: string): string {
  return `---
name: ${name}
description: Locates the code and docs relevant to a question or task in a large or unfamiliar codebase, ranking files with jev-axi before reading them. Use proactively for broad exploration, tracing a flow across files, or finding where something is implemented when there is no obvious identifier to search for.
tools: Bash, Read, Grep, Glob
skills:
  - jev-axi
---

${PROMPT}
`;
}

export function agentPath(name: string, project: boolean): string {
  const base = project ? join(process.cwd(), ".claude", "agents") : join(homedir(), ".claude", "agents");
  return join(base, `${name}.md`);
}

/**
 * Install or remove the exploration subagent. With `replaceExplore`, it is installed under the
 * name `Explore`, which overrides Claude Code's built-in explorer for this scope.
 */
export function configureAgent(project: boolean, remove: boolean, replaceExplore: boolean): { file: string; status: string } {
  const name = replaceExplore ? "Explore" : "jev-explore";
  const file = agentPath(name, project);
  const ours = existsSync(file) && readFileSync(file, "utf8").includes(MARKER);
  if (remove) {
    if (!ours) return { file, status: existsSync(file) ? "not ours, left untouched" : "not installed (no-op)" };
    rmSync(file);
    return { file, status: "removed" };
  }
  if (existsSync(file) && !ours) return { file, status: "a different agent with this name exists; left untouched" };
  const content = agentFile(name);
  if (ours && readFileSync(file, "utf8") === content) return { file, status: "already installed (no-op)" };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return { file, status: ours ? "updated" : "installed" };
}
