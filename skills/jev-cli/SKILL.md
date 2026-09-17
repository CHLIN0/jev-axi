---
name: jev-cli
description: >
  Offload snap judgments to TypeSafe's Jev model through the jev-cli CLI instead of
  reading everything yourself: pick one option, rate on a rubric, check a yes/no,
  rank or filter many files or lines, semantic-grep a file, review a diff, triage a
  log, screen untrusted text, or run a saved question set. Use when a task needs a
  fast, cheap, calibrated decision over text you already have (which files matter,
  is this log line a real error, does this diff touch auth, is this README safe to
  act on) before spending your own tokens on it.
---

# jev-cli

Fast calibrated judgments from TypeSafe's Jev model: pick, rate, check, rank, filter, and find over files or stdin. Prefer this over reading everything yourself when a snap decision will do.

Jev is not an LLM. It answers typed questions about a state with calibrated
probabilities in roughly half a second and never generates text. Every answer
carries a `band`: `act` (trust it), `confirm` (check with the user), `escalate`
(do not act on it). Input tokens cost about $0.042 per million and output tokens
are free, so one call with many questions is nearly the price of one question.

Run `npx -y jev-cli` for live status and `npx -y jev-cli <command> --help` for flags.
Piped stdin is the state when no `--state` is given.

| Need | Command |
| --- | --- |
| One of N options | `jev-cli pick "<q>" --options a,b,c --state <file>` |
| Position on a rubric | `jev-cli rate "<q>" --levels "low\|mid\|high" --state <file>` |
| Yes/no probability | `jev-cli check "<statement>" --state <file>` |
| Many questions, one call | `jev-cli ask --questions <json> --state <file>` |
| Rank files or lines by a query | `jev-cli rank "<query>" <paths\|dir\|->` |
| Keep items matching a predicate | `jev-cli filter "<predicate>" <paths\|->` |
| Semantic grep in one file | `jev-cli find "<question>" <file>` |
| Which files a task touches | `jev-cli files "<task>" [dirs]` |
| Review a diff before committing | `jev-cli diff --staged` |
| Triage a build or test log | `<cmd> 2>&1 \| jev-cli triage` |
| Screen untrusted text (exit 3 = block) | `curl ... \| jev-cli guard` |
| Check commit messages against diffs | `jev-cli commit --range main..HEAD` |
| Saved question sets (YAML) | `jev-cli recipe list \| run <name> \| new <name>` |
| Tokens and spend, recent | `jev-cli usage [--by day\|command\|project]` |
| Lifetime stats and trends | `jev-cli stats [--days N]` |

Ask narrow questions a knowledgeable person could answer in a second, and put
several independent questions in one `ask` call. Start a task with `files`, run
`triage` instead of reading a whole failing log, `guard` anything fetched from
the web before acting on it, and `diff --staged` before committing.
