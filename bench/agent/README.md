# Agent benchmark

Measures whether Claude Code gets real work done cheaper, faster, or more correctly when
jev-axi is available. Each task runs as a headless `claude -p` session in a fresh copy of a
pinned repository (`tasks.yaml` names the repo and commit), under these conditions:

| condition | skill | jev-axi on PATH | SessionStart hook |
| --- | --- | --- | --- |
| `baseline` | no | no | no |
| `jev-axi` | in `.claude/skills` | yes | no |
| `jev-axi-hook` | in `.claude/skills` | yes | yes, as `jev-axi setup hooks --project` installs |
| `jev-axi-agent` | in `.claude/skills` | yes | no; adds the `jev-explore` subagent (`jev-axi setup agent --project`) |
| `jev-axi-explore` | in `.claude/skills` | yes | no; the same subagent installed as `Explore` (`--replace-explore`) |
| `jev-axi-forced` | in `.claude/skills` | yes | no; the prompt tells the agent to use jev-axi (upper bound) |

Prompts never mention jev-axi (except in `jev-axi-forced`), so the benchmark measures whether it gets used on its own and
whether that pays off.

```sh
pnpm build
python3 bench/agent/bench.py --repo ~/Work/t3code --only theme-size-limits --repeats 1   # smoke test
python3 bench/agent/bench.py --repo ~/Work/t3code --repeats 3 --parallel 4 --model sonnet
python3 bench/agent/bench.py --repo x --rescore bench/agent/results/<stamp>              # regrade after editing tasks.yaml
```

Per run it records, in `results/<stamp>/runs.jsonl` (gitignored):

- Claude's `total_cost_usd`, turns, duration, and token usage from `--output-format json`
- Jev's token spend from an isolated jev-axi ledger, priced at $0.042 per million input tokens
- from the session transcript and its subagent transcripts: file reads, searches, subagents
  spawned, jev-axi commands run, and whether the skill was loaded
- whether the final answer matched the task's `expect` patterns (all required) or
  `expect_min` (at least `min` of `patterns`)

This spends real Claude and TypeSafe credits: a narrow task costs about $0.15 per run with
Sonnet, a broad multi-file task $0.25 to $1. Run-to-run variance is large, so compare medians
over several repeats before drawing conclusions.

Task design notes:

- Narrow "where is X" questions are solved by `grep` in a few turns; they are sanity checks.
- The expensive pattern in real transcripts is broad exploration across many files (see
  `bench/transcripts/mine.py`), so the tasks that matter are the broad ones.
- Claude Code often explores inside subagents, which is why subagent transcripts are counted.
