# Contributing

Thanks for helping make jev-axi better. It is small on purpose, so most
contributions are one of three kinds.

## Setup

```sh
pnpm install
export TYPESAFE_API_KEY=...     # only needed for live runs; tests use a fake API
pnpm dev -- check "Is this urgent?" --text "ASAP"
pnpm test
pnpm lint
pnpm build
```

## Improving questions

The most valuable changes are better questions. Every built-in recipe's
questions and thresholds live in `src/recipes/questions.ts`. When you change
one, run the command live on a few real inputs and paste before/after output
in the pull request. Wording matters a lot: a rewrite can move a probability
from 0.2 to 0.7 on the same input.

Rules of thumb from the TypeSafe docs:

- One narrow judgment per question. Split anything that weighs several factors.
- The question id is not sent to the model; put the full meaning in `instructions`.
- Point at parts of the state with backticked paths like `` `F001.patch` ``.
- Use structured `criteria` with `true`/`false` examples when the boundary is subtle.
- Output tokens are free, so add speculative questions rather than making a second call.

## Adding a command

Follow the [AXI principles](https://github.com/kunchenguid/axi): TOON output,
3 to 4 fields per row, definitive empty states, structured errors on stdout,
unknown flags rejected with the valid list, and next-step hints. Add the
command to `src/commands/table.ts` so the home view and generated skill pick
it up, then run `pnpm build:skill`. Add a test that drives it through `main()`
with the fake API in `test/`.

## Pull requests

- Keep each PR to one change.
- `pnpm test`, `pnpm lint`, and `pnpm check:skill` must pass; CI runs them.
- Never commit an API key. `.env` is gitignored; keep it that way.

## Releasing

Bump `version` in `package.json` and `src/version.ts`, commit, then create a
GitHub release with a `vX.Y.Z` tag. The `publish` workflow runs lint, tests,
and build, then publishes to npm with provenance using the `NPM_TOKEN` secret.
