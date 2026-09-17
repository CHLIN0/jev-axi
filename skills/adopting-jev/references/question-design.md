# Designing the questions

The questions and thresholds are the part humans should review, and the part models are worst at
writing. Take the time here; wording moves results more than thresholds do.

## Decompose first

The docs call decomposition "probably the most important concept". One broad verdict ("is this
spam?", "is this tool call correct?", "rate this pitch") hides the reasoning and scores worse: a
single phishing verdict reached 62.6% where five narrow signals reached 95.0%.

Write the narrow facts a person would check, ask each as its own question, and combine them in
code where you can see and tune the rule.

## Choosing the type

| Type | Use for | Returns | Watch out for |
| --- | --- | --- | --- |
| **noul** | a fact that is true or false | `noul`: probability of yes. **No confidence field** | 0.5 means "unsure", not "medium". Don't use it for degree |
| **choice** | one of a written-down set, up to 255 | `choice`, `probabilities` over all options, `confidence` | Probabilities sum to 1, so something always wins: add `none`/`other`, or a separate "does any fit" noul |
| **score** | a degree, 2 to 10 ordered levels | `score` (probability-weighted mean, can land between levels), `probabilities`, `confidence` | Each level is judged alone; the model never sees level numbers or its neighbours |

## Writing instructions

- The **whole question goes in `instructions`**. Question IDs are never sent to the model, so
  `urgent: {instructions: "..."}` tells the model nothing by its name.
- **Name the narrowest fact that decides it.** A formatting cookbook changed "same paragraph" to
  "picks up mid-sentence" and the block count went from 12 (wrong) to 17 (right). One project's
  rule: "the right fix is usually to phrase the condition better, not to move the threshold".
- **Point at parts of the state** with backticked paths: "Does `ticket.messages[0].text` request a
  refund that `refund_policy` allows?"
- **Give the context the judgment needs.** A guardrail that doesn't know what the assistant is for
  is guessing at the policy: adding deployment context raised injection recall from 75% to 95%.
- **Instructions and criteria can be structured**, not just strings: `{question, focus, compare}`
  for instructions, `{what, not_for, examples}` for an option or a noul's true/false case. Field
  names are free-form. Use structure to separate confusable options.
- Keep each question about **one dimension**. Several dimensions in one level description ("punctual
  and smart and experienced") lower confidence.

## Criteria

- **Noul criteria** (`{true, false}`) are optional and pin down boundaries. Adding them took spam
  accuracy from 95.96% to 98.33%, matching a classifier trained on 14.8k labels. The same criteria
  *hurt* on a different corpus (98.6% → 97.0%), so validate criteria on the data they'll run on.
- **Framing "true = something is wrong"** is fine when the criteria say so explicitly (extraction
  verification does this deliberately). What hurts is contradiction: a `true` case that describes
  the negative.
- **Score levels describe situations**, never bare numbers: `["0", "1", "2"]` measurably fails. If
  a rare extreme needs different handling, give it its own level.
- **Examples** in criteria only help when they resemble real inputs.

## Batching and fan-out

- Put every question about the same state in **one request**. Coding agents habitually make one
  call per question; that cost 12x more and ran 10x slower in TypeSafe's own test.
- **Speculative fan-out**: ask the questions for every branch at once and let code ignore the ones
  that don't apply. Cheaper than a second round trip.
- Use a **second request** only when the first answer changes what you send: new state to fetch, a
  narrower option list, or the next level of a taxonomy.
- **One question per item** beats one positional list when each item needs its own judgment;
  positional lookup degrades past roughly 16 items.

## Turning answers into decisions

- **Bands, not one cutoff.** Probabilities wobble by about 0.01 between runs, and borderline cases
  flip. Use act / review / escalate bands with a middle band that goes to a human, and set the
  thresholds per action according to what a mistake costs.
- **For "pick the best", take the argmax**; confidence matters for acting automatically, not for
  ranking.
- **Combine with max, not mean.** In extraction verification, escalating when *any* field exceeds
  0.7 is the point; averaging flags away a single confident red flag.
- **For composite calls, use the minimum** over the judgments involved, not a product.
- **Normalize scores** by `len(levels) - 1` before weighting several together.
- **Don't interpolate exact magnitudes** from a score's expected value, and don't compare absolute
  probabilities across differently worded questions.
- Keep the questions and thresholds **in one file**. That file is what a human reviews.

## A worked shape

```python
# questions.py: the reviewable part
TICKET_QUESTIONS = {
    "department": {"type": "choice", "instructions": "Which team should handle this ticket?",
                   "criteria": {"billing": "Charges, invoices, refunds",
                                "technical": "The product is broken or erroring",
                                "sales": "Pre-purchase questions, quotes",
                                "other": "None of the above"}},
    "urgent": {"type": "noul",
               "instructions": "Is the customer blocked right now, with no workaround?",
               "criteria": {"true": "Production is down, money is stuck, or a deadline is today",
                            "false": "Annoying but they can keep working"}},
    "frustration": {"type": "score",
                    "instructions": "How upset does the customer sound?",
                    "criteria": ["Neutral or friendly",
                                 "Mildly annoyed but civil",
                                 "Angry, threatening to leave or escalate"]},
}
THRESHOLDS = {"urgent_act": 0.75, "urgent_review": 0.45, "department_min_confidence": 0.60}
```

Code reads `department` only when its confidence clears the threshold, pages someone when
`urgent` is above `urgent_act`, and routes the middle band to a person.
