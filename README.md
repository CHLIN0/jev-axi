# jev-axi

`jev` for TypeSafe's Jev model, `axi` for the [Agent eXperience Interface](https://github.com/kunchenguid/axi) conventions it follows.

[![ci](https://github.com/shiftynick/jev-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/shiftynick/jev-axi/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jev-axi?style=flat-square)](https://www.npmjs.com/package/jev-axi)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

An [AXI](https://github.com/kunchenguid/axi) (agent-ergonomic CLI) for
[TypeSafe's Jev](https://docs.typesafe.ai/introduction), a System One model
that answers typed questions about text with calibrated probabilities in about
half a second. It never generates text. Agents use `jev-axi` to offload snap
judgments instead of reading everything into context.

```sh
npm install -g jev-axi        # or: npx -y jev-axi ...
export TYPESAFE_API_KEY=...   # or put it in ./.env, or `jev-axi config set apiKey ...`
jev-axi                       # live status: key, model, usage, commands
```

## Commands

| Need | Command |
| --- | --- |
| One of N options | `jev-axi pick "<q>" --options a,b,c --state <file>` |
| Position on a rubric | `jev-axi rate "<q>" --levels "low\|mid\|high" --state <file>` |
| Yes/no probability | `jev-axi check "<statement>" --state <file>` |
| Many questions, one call | `jev-axi ask --questions <json> --state <file>` |
| Rank files or lines by a query | `jev-axi rank "<query>" <paths\|dir\|->` |
| Keep items matching a predicate | `jev-axi filter "<predicate>" <paths\|->` |
| Semantic grep in one file | `jev-axi find "<question>" <file>` |
| Review a diff before committing | `jev-axi diff [--staged \| --range a..b]` |
| Which files a task touches | `jev-axi files "<task>" [dirs]` |
| Triage a build or test log | `<cmd> 2>&1 \| jev-axi triage` |
| Screen untrusted text | `curl ... \| jev-axi guard` (exit 3 on block) |
| Check commit messages against diffs | `jev-axi commit [--range a..b]` |
| Saved question sets (YAML) | `jev-axi recipe list \| run <name> \| new <name>` |
| Show or clear the response cache | `jev-axi cache [clear [--stale]]` |
| Tokens and estimated spend, recent | `jev-axi usage [--by day\|command\|project]` |
| Lifetime stats and trends | `jev-axi stats [--days N]` |
| Models, config, agent hooks | `jev-axi models`, `jev-axi config`, `jev-axi setup hooks` |

State comes from `--state <path|->`, `--text "<literal>"`, `--state-json '<json>'`,
or piped stdin. Every command supports `--json`, `--full`, `--model`, `--no-cache`, `--help`.

## Reading the output

```
$ jev-axi pick "Which team should handle this?" --options billing,technical,sales --text "Our webhook has returned 500s since this morning's deploy"
pick: technical
confidence: 1
band: act
options[3]{option,p}:
  technical,1
  billing,0
  sales,0
usage: 318in/38out 402ms jev-1.13.0 $0.00001
```

- `p` is a probability. Choice probabilities sum to 1 across options.
- `confidence` (0..1) summarizes how peaked the distribution is. For yes/no
  answers it is the distance from 0.5, rescaled.
- `band` is a policy the agent can branch on: `act` (>= 0.75), `confirm`
  (>= 0.45), `escalate` (below). Tune with `--act`, `--confirm`, or `config set`.
- `usage` shows tokens, latency, the concrete model version, and estimated cost.

Identical requests are served from a local cache and marked `cached`. A cached
answer is reused for up to 24 hours (`jev-axi config set cacheTtlHours <n>`, 0 to
disable) and only while `jev-latest` still resolves to the model version that
produced it, so a model update invalidates old answers automatically.
`jev-axi cache` shows the cache and `jev-axi cache clear [--stale]` empties it.

Commands read piped stdin when there is content on it. Agent harnesses usually run
commands with an empty stdin; that counts as no input, so `jev-axi diff` reviews the
working tree and commands that need input say which flag or path to pass.

## Batch commands

`rank`, `filter`, and `find` tag items or lines with short ids and send them as
one request, chunking automatically at 255 options or the token budget. Each
ranking is paired with a yes/no "does anything here match" question, so an
empty result is definitive rather than the least bad option.

```
$ jev-axi rank "code that decides the retry delay" src/
query: code that decides the retry delay
match_exists: 0.93
band: act
count: 10 shown of 41 items
ranked[10]{rank,p,item,preview}:
  1,0.62,src/net/retry.ts,"export function backoff(attempt: number) { …"
  ...
```

## Recipes

The recipe commands are opinionated workflows built from the primitives. Their
questions and thresholds live in one file, `src/recipes/questions.ts`, so they
can be reviewed and tuned without reading the command code.

- `diff` asks five questions per changed file (risk, needs a test, adds a
  secret, debug leftovers, changes behavior) plus scope and kind for the whole
  diff, and returns `ok`, `review`, or `block`.
- `files` ranks every source file under a directory by how likely a developer
  needs to open it for a task. Run it before reading anything.
- `triage` takes the tail of a log and returns the root-cause line, failure
  category, whether it looks flaky, and severity. When the log shows no failure it
  says so instead of guessing a root cause.
- `guard` screens text for prompt injection, hidden instructions, exfiltration
  or destructive directives, embedded secrets, and pressure tactics. It exits 3
  on `block` so pipelines can gate on it.
- `commit` checks each commit's message against its diff.
- `recipe` runs your own YAML question sets from `./.jev-axi/recipes/` or
  `~/.config/jev-axi/recipes/`; `recipe new <name>` scaffolds one.

## Usage, spend, and trends

The TypeSafe API reports per-request token counts but has no spend endpoint,
so `jev-axi` keeps a ledger of every call in your config folder
(`~/.config/jev-axi/stats/usage.jsonl`). Each record has the command, model,
tokens, latency, cache status, the project it ran in, and how many answers
landed in each confidence band.

- `jev-axi usage` is the recent view: a window of days broken down by command,
  day, model, or project.
- `jev-axi stats` is the lifetime view: totals since first use, this period
  versus the previous one, daily sparklines for calls and cost, per-command and
  per-project tables with average questions per call and the share of confident
  answers, cache hit rate, records, and a projected monthly cost.

The
default price is $0.042 per 1M input tokens with output tokens free, which is
why packing many questions into one call is nearly free; override if your plan
differs:

```sh
jev-axi config set price.input 0.05    # USD per 1M input tokens
jev-axi config set price.output 0.05
```

## Agent integration

- `jev-axi setup hooks` installs SessionStart hooks for Claude Code, Codex, and
  OpenCode so each session begins with the status view. Add `--project` to
  scope it to the current repository.
- `skills/jev-axi/SKILL.md` is an installable skill for on-demand discovery.

## Development

```sh
pnpm install
pnpm dev -- check "Is this urgent?" --text "ASAP"
pnpm test
pnpm build
```

Files: `~/.config/jev-axi/config.json`, `~/.config/jev-axi/stats/usage.jsonl`,
`~/.config/jev-axi/recipes/`, `~/.cache/jev-axi/`. XDG variables and Windows
AppData paths are honored. `pnpm build:skill` regenerates `skills/jev-axi/SKILL.md`
from the command table; `pnpm check:skill` fails when it is stale.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). MIT licensed.
