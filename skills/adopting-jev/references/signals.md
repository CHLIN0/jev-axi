# Finding candidates in a codebase

What to grep for, what it means, and what it turns into. Run the searches that match the
project's languages, then record each hit as file:line with what decides today.

## The four shapes worth finding

1. **An LLM call whose whole job is to pick a label, answer yes/no, or give a number.** The give
   away is the parsing right after the call.
2. **Rules over free text** that keep growing: keyword lists, `if "refund" in text`, regex
   classifiers, similarity cutoffs.
3. **A queue people work through by hand**: moderation, claims, support, review, dedup.
4. **A big model used as a judge or a gate** in evals, guardrails, or agent loops.

## Grep patterns

Language-agnostic first pass:

```sh
# LLM calls at all: find the files worth reading
rg -n --stats -e 'chat\.completions|responses\.create|messages\.create|generateText|generateObject' \
   -e 'openai|anthropic|@ai-sdk|litellm|langchain|llamaindex|bedrock|vertexai|ollama' .

# Prompts that classify, rate, or ask yes/no
rg -n -i -e 'classify|categoriz|respond with one of|choose one|label this|which category' \
        -e 'answer (only )?(yes|no)|true or false|is this (a|an) ' \
        -e 'on a scale|rate (this|the)|score (from|between)|1 to 10|0 to 5' .

# Parsing a model's reply back into a type: the strongest single signal
rg -n -e '"yes" in .*lower\(\)|== *"yes"|startswith\("yes"' \
   -e 'json\.loads\(.*(content|message|response)|JSON\.parse\(.*(content|text|message)' \
   -e 'max_tokens *= *[1-5]\b|logprobs|response_format' \
   -e 're\.(search|match)\(.*(response|completion|reply)' .

# Keyword and regex rules over user text
rg -n -e 'SPAM_WORDS|BLOCKLIST|BLACKLIST|BANNED_WORDS|KEYWORDS *=|TOXIC' \
   -e 'if .*(in|includes|contains).*(text|message|body|comment|subject)' \
   -e 'startswith\("/|\.test\(.*(message|input|prompt)' .

# Similarity thresholds standing in for a relevance decision
rg -n -e 'cosine|similarity *[<>]=?|score *[<>]=? *0\.[5-9]|top_k|topK' \
   -e 'rerank|cross.?encoder|cohere' .

# Moderation and safety vendors
rg -n -e 'moderations?\.create|/v1/moderations|perspective.*api|detoxify|openai\.Moderation' .

# LLM-as-judge and eval harnesses
rg -n -e 'judge|grader|rubric|eval(uate)?_(answer|response)|llm_as|gpt.?4.*judge' \
   -e 'promptfoo|ragas|deepeval|braintrust|langsmith' .

# Manual queues and human triage
rg -n -i -e 'needs_review|manual_review|triage|assigned_to|escalat|priority *=|P[0-3]\b' .

# Agent guardrails built from command patterns
rg -n -e 'PreToolUse|pre_tool_use|allow(ed)?_?(commands|list)|deny_?list|DANGEROUS_' .
```

Python-specific:

```sh
rg -n -t py -e 'Literal\[|enum\.Enum|class .*\(str, Enum\)' -B3 -A3 | rg -n 'prompt|llm|completion'
rg -n -t py -e '@tool|function_call|tools *= *\[' .
```

JS/TS-specific:

```sh
rg -n -t ts -e 'z\.enum\(|as const\]|type .* = "[a-z_]+" \|' -B3 -A3 | rg -n 'prompt|model|generate'
rg -n -t ts -e 'zodResponseFormat|generateObject\(|tool\(\{' .
```

Config and prompt files, which often hide the real rules:

```sh
rg -n -i -e 'classify|categor|label|intent|toxic|spam|urgen' --glob '*.{yaml,yml,json,toml,md,txt}' .
fd -e md -e txt . prompts/ templates/ 2>/dev/null | head -50
```

## Reading a hit

For each candidate, write down:

- **Decides what**, and the full outcome space. If you can't enumerate it, Jev probably doesn't fit.
- **What decides it now**: model and prompt, regex, or a person.
- **Volume and latency**: calls per day, and whether a user waits for it. This drives the value.
- **Input size**: does the text fit in about 32k tokens after filtering?
- **Sensitivity**: does the input carry secrets, PII, or regulated data?
- **Stakes**: what happens when it's wrong, and is there a review path?

## Quick value estimate

Jev costs about $0.042 per 1M input tokens, output free, and takes roughly 0.1 to 0.5 s.

```
cost per 1000 items ≈ (average input tokens per item × 1000) ÷ 1,000,000 × 0.042
```

Roughly 700 tokens per item works out to about $0.03 per 1,000 items. Compare against the current
per-item cost and latency, and say plainly when the saving is too small to bother with: a
classification that runs 50 times a day is not worth a migration.

## Signals that a candidate is a trap

- The prompt asks for a label **and** an explanation the product shows to users.
- The "label" is really an extraction with no candidate list.
- The decision is arithmetic, a date comparison, or a count.
- A regex already separates the data cleanly.
- The site is the only thing standing between untrusted input and something dangerous.

See [fit-and-limits.md](fit-and-limits.md) for the full rule-out list.
