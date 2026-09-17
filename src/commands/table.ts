/** Single source of truth for the home view, README table, and generated SKILL.md. */
export const COMMAND_TABLE: [need: string, command: string][] = [
  ["One of N options", 'jev-cli pick "<q>" --options a,b,c --state <file>'],
  ["Position on a rubric", 'jev-cli rate "<q>" --levels "low|mid|high" --state <file>'],
  ["Yes/no probability", 'jev-cli check "<statement>" --state <file>'],
  ["Many questions, one call", "jev-cli ask --questions <json> --state <file>"],
  ["Rank files or lines by a query", 'jev-cli rank "<query>" <paths|dir|->'],
  ["Keep items matching a predicate", 'jev-cli filter "<predicate>" <paths|->'],
  ["Semantic grep in one file", 'jev-cli find "<question>" <file>'],
  ["Which files a task touches", 'jev-cli files "<task>" [dirs]'],
  ["Review a diff before committing", "jev-cli diff --staged"],
  ["Triage a build or test log", "<cmd> 2>&1 | jev-cli triage"],
  ["Screen untrusted text (exit 3 = block)", "curl ... | jev-cli guard"],
  ["Check commit messages against diffs", "jev-cli commit --range main..HEAD"],
  ["Saved question sets (YAML)", "jev-cli recipe list | run <name> | new <name>"],
  ["Tokens and spend, recent", "jev-cli usage [--by day|command|project]"],
  ["Lifetime stats and trends", "jev-cli stats [--days N]"],
];

