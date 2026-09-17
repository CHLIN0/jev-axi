# Does Jev fit here?

What Jev can and can't do, with the measured evidence, so a recommendation is honest about both.

## What it is

- Answers typed questions about a **state** (a string, a JSON object, or an array of text) with
  calibrated probabilities. No generated text, no explanation, no images or audio.
- Three question types: **noul** (probability of yes), **choice** (one of up to 255 options,
  returning probabilities over all of them plus a confidence), **score** (2 to 10 ordered levels,
  returning a probability-weighted mean).
- All questions in a request see the same state and are evaluated independently, in parallel.
  Asking more questions barely changes the response time.
- `POST /v1/systemone` with `{state, model, questions}`, answered by a versioned model such as
  `jev-1.13.0`. SDKs: `typesafe-sdk` (Python 3.10+), `@typesafe-ai/sdk` (Node 20+), plus a Vercel
  AI SDK provider and community clients for Rust, Go, Ruby, Elixir, .NET, PHP, and Scala.

## Numbers to plan with

| Property | Value | Source |
| --- | --- | --- |
| Price | $0.042 per 1M input tokens; output free | TypeSafe models page; confirmed by an independent bench billed input-only |
| Latency | docs say ~100 ms; measured round trips 111 to 325 ms, ~1.2 s on a cold TLS connection | consistency cookbooks, community benches |
| Input budget | ~32k tokens for state plus the longest question (one page says 64k for everything together) | primitives page, jaggedness page |
| Batching | 13 questions in one call: 12x cheaper and 10x faster than 13 calls, same answers | parallel-questions cookbook |
| Rate limits | 250k tokens/s, 1,200 requests/min; 529s reported at 100 concurrent requests, fine at 16 | models page, community projects |
| Consistency | self-consistent, not deterministic: per-question probability SD ~0.010 over 15 repeats, but borderline labels do flip | consistency cookbooks |

## It fits when

- The outcome is **one of a set you can write down**, a yes/no, or a position on a scale.
- The input is **text that fits the budget** after filtering, or can be chunked per item.
- The judgment is the kind a person makes in a second or two from the text in front of them.
- Being wrong occasionally is survivable, or an uncertain band can route to review.
- **Volume or latency matters**: the win is 10 to 100x on cost and often 10x on latency, not
  better accuracy.

## Rule it out when

- **Output must be generated text**: replies, summaries, explanations, code, rewrites. Chaining
  choices to generate text "will not work well and will be very slow".
- **The reasoning is long or multi-hop** and can't be decomposed into snap judgments.
- **Exact extraction with no candidate list.** With candidates (regex, NER, a roster) a choice
  works well and returns a verbatim span.
- **Arithmetic, counting, dates, or numeric closeness.** It does not count reliably or order dates.
  Extract parts with choices and compute in code; count with one noul per item summed in code.
- **Numeric representations** (hex colors, RGB, binary, assembly) do worse than semantic ones.
- **Non-text input**: images, audio, video.
- **A regex or parser already decides exactly.** In the phishing bench a two-line rule scored
  91.8%, beating Jev's best single question.
- **It would be the only thing standing between untrusted input and harm.** Both TypeSafe's docs
  and the projects say it is a filter, "not a security boundary" and "not a sandbox".
- **The input carries secrets, PII, or regulated data** you can't send to a third party.
  Enterprise data residency and retention terms are not published.
- **The decision needs an auditable natural-language rationale.** You get numbers; the caller must
  log state, questions, answers, and thresholds.

## Where Jev measurably lost

Say these out loud when recommending; they're the difference between a useful proposal and a sales
pitch.

- **A single broad verdict question is weak.** "Is this phishing?" scored 62.6% against Haiku's
  81.3%. Decomposed into five signals it reached 95.0%.
- **TypeSafe's own workflow evals** don't list Jev among the top performers for invoice processing,
  customer service, or agent-trace observability. It is roughly tied on security alert triage
  (61.7% vs 62.5%) at about 1/300th the cost.
- **An independent write-up** measured mean agreement of ~67.8% against ~74.1% for the best
  comparator, concluding "cheaper and faster, not more accurate".
- **Reranking in French** trailed Cohere by 6.4 points, while English was a tie.
- **Order sensitivity**: reversing 30 candidate passages changed the top pick on 24.7% of queries.
- **An LLM asked the same decomposed questions** matched Jev's accuracy in two benchmarks, at
  roughly 27x the cost. The win is price and latency, not judgment.
- **"Zero hallucinations"** means the response schema is guaranteed, not that the answer is right.

## Known rough edges

- **Literal reading**: it answers the question you wrote, not the one you meant.
- **Indirection**: double negatives and multi-hop questions lose accuracy.
- **Large irrelevant state** causes context rot; filter first, or gate relevance with a noul.
- **Adversarial text** in the state can steer answers; it isn't treated as hostile by default.
- **Contradictory instructions and criteria** (a noul whose `true` case describes the negative)
  degrade answers.
- **Calibration is a property of groups**, not a guarantee about any single answer, and absolute
  probabilities aren't comparable across differently worded questions. Ranking is the reliable
  part; set thresholds per question from real data.
