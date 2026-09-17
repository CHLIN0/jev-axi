# Benchmarks and the eval loop

Two layers, with very different costs.

## 1. Recipe evals (cheap, run often)

`bench/cases/*.yaml` holds labeled cases for each recipe: injected and clean
texts for `guard`, real-shaped logs for `triage`, hand-written patches for
`diff`, tasks against this repo's own `src/` for `files`, questions against
single files for `find`, and short unambiguous texts for the primitives.

```sh
pnpm eval                                   # run everything (~40 cases, a few cents at most)
pnpm eval --only guard,triage               # a subset
pnpm eval --verbose                         # print passing cases too
pnpm eval --fresh                           # bypass the response cache
pnpm eval --model jev-preview               # A/B another model
pnpm eval --save baseline                   # record bench/results/baseline.json
pnpm eval --compare bench/results/baseline.json   # exit 1 on any regression
```

The loop for improving a recipe:

1. Run `pnpm eval --compare bench/results/baseline.json` to see the current state.
2. Edit the questions or thresholds in `src/recipes/questions.ts`.
3. Rerun with `--compare`. Changed questions miss the cache automatically, so
   only the affected calls are re-billed.
4. When the numbers are better, `pnpm eval --save baseline` and commit both.

Add a case whenever a recipe answers a real input wrongly: put the input under
`bench/fixtures/`, add an entry with the expected outcome, and it becomes a
regression test for the questions. Expectations are deliberately loose where
the model has legitimate room (for example `verdict_in: [block, review]`), and
strict where a wrong answer would mislead an agent.

## 2. Agent benchmark (costs real model time, run deliberately)

`bench/agent/run.sh` runs the same coding tasks through Claude Code with and
without jev-axi available, and records cost, turns, and duration from the
CLI's JSON output. See `bench/agent/README.md`. This mirrors the methodology
of the [AXI benchmarks](https://github.com/kunchenguid/axi#results).
