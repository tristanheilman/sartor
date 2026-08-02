# Evals

Gold-standard cases the tailoring pipeline is measured against.

```
npm run eval        # run them, print the table
npm test            # they also run here — they are ordinary tests
```

```
case                      pass  recall  reqs   lines
------------------------  ----  ------  -----  ---------
platform-stretch           ok     1.00    1.00      36/52
```

## Why this can work at all

"Is this a good resume?" is unanswerable. But the plan a model returns is
**IDs, not prose** — so most of what we care about reduces to set membership:

- Did the four bullets a human marked essential survive?
- Did the padding stay out?
- Did it invent an employer, a number, or a technology?
- Does it fit the page?
- Can the rendered PDF be read back out?

All checkable. None of it requires anyone to judge writing quality.

## No network

Everything downstream of the model call is pure:

```
plan → validatePlan → buildChanges → buildDocument → guard / coverage / render
```

So the **cassette is the plan**, not the HTTP response. `plan.json` is small,
readable, and reviews in a diff — unlike a recorded SSE stream. Replaying one
exercises the entire pipeline deterministically, for free, on every PR.

Re-recording a plan against a live provider is a separate, deliberate act. It
costs money, needs a key, and changes what the eval means, so it is never part
of `npm test`.

## Gates vs. scores

**Gates** are pass/fail and non-negotiable. A fabricated employer is not a low
score, it is a broken build.

| gate | what it catches |
|---|---|
| `no-fabrication` | a proper noun or number in the output that is not in the profile |
| `no-forbidden-terms` | claiming a specific thing the case says the candidate lacks |
| `no-padding` | including bullets a human marked irrelevant |
| `fits-page-target` | overflowing the page budget |
| `parse-safety` | a structure that breaks downstream parsers |

**Scores** are 0–1, compared against `baseline.json` so a prompt change shows up
as a delta rather than a feeling. `recall` is the fraction of essential bullets
kept. `requirementCoverage` is the fraction of the posting's emphasised
requirements *that the profile can actually support* which made it into the
document — terms the candidate genuinely lacks are excluded, because failing to
show evidence that does not exist is not a miss.

These numbers are for this repository, not for users. `coverage.ts` refuses to
show anyone a 0-100 resume score and that reasoning still holds. The question
here is different: is version N+1 of our selector better than version N, on
cases where we already know the answer?

## The round trip

Each case renders a real PDF and reads it back with `extractResumeText` — the
same extractor that ingests a user's resume. Every bullet that made the cut has
to come back out intact.

This is the check no unit test substitutes for. A resume whose text does not
survive extraction is unreadable to every downstream parser, however good it
looks on screen.

## Adding a case

Drop a folder in `cases/`. It is picked up automatically.

```
cases/<name>/
  profile.json   a master profile
  posting.txt    a real-shaped job posting
  plan.json      the model response being evaluated
  labels.json    what a good answer looks like
```

```jsonc
{
  "intent": "Why this case exists and what it is trying to catch.",
  "pageTarget": 1,
  "mustInclude": ["blt_..."],   // bullets a competent human would keep
  "mustExclude": ["blt_..."],   // padding for this posting
  "forbidden": ["Kubernetes"]   // must appear nowhere in the output
}
```

The cases worth writing are the ones with a **trap**. `platform-stretch` demands
Kubernetes and Terraform that the profile does not have; passing means the
pipeline left the gap visible instead of filling it. A case where everything
lines up tests very little.

Others worth adding: a fifteen-year career forced onto one page (aggressive
cutting, recall of the *recent* and relevant), a thin junior profile against a
senior posting (must not pad), and a career changer whose relevant evidence is
all in `projects` rather than `work`.

## Changing the baseline

A regression fails the run and prints `before -> after`. Either fix it, or
accept it by updating `baseline.json` **in the same commit** — so the diff
records that a human decided the trade was worth it.
