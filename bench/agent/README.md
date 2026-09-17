# Agent benchmark

Measures whether an agent finishes coding tasks cheaper and in fewer turns
when jev-axi is available. Each task runs in a fresh clone of a target
repository under two conditions:

- `baseline`: Claude Code with no mention of jev-axi.
- `jev-axi`: the same, with a `CLAUDE.md` line telling the agent to use
  `jev-axi files`, `find`, and `triage` before reading files or logs.

Every run uses `claude -p` with `--output-format json`, which reports
`total_cost_usd`, `num_turns`, and `duration_ms`. Runs are repeated `REPEATS`
times per condition and the medians are reported.

```sh
export TYPESAFE_API_KEY=...          # for the jev-axi condition
REPEATS=3 MODEL=claude-sonnet-4-6 bench/agent/run.sh https://github.com/kunchenguid/gh-axi bench/agent/tasks.yaml
```

This costs real money: roughly (tasks x conditions x repeats) Claude Code
sessions. Start with `REPEATS=1` and one or two tasks. Results land in
`bench/agent/results/<timestamp>.jsonl`, one line per run, plus a summary
table on stdout.

`tasks.yaml` holds tasks as `{ name, prompt, check }` where `check` is a
shell command run in the clone afterwards that exits 0 on success, so success
rate is measured, not just cost.
