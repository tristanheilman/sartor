# sartor CLI reference

## Installing

`sartor` is not published to npm yet. Install it from a clone:

```bash
git clone https://github.com/tristanheilman/sartor.git
cd sartor
npm install
npm run build:lib
npm link        # puts `sartor` on PATH
```

Requires Node 20.19 or later. A clone has everything rendering and PDF reading need.

## Output

Every command prints one JSON envelope on stdout when stdout is not a terminal (or with `--json`), and text at a terminal (or with `--human`). Progress and diagnostics go to stderr.

```json
{
  "ok": true,
  "command": "tailor apply",
  "data": { "...": "the result" },
  "warnings": ["things to tell the person"],
  "next": ["commands that usually come next"]
}
```

On failure `ok` is `false` and `error` replaces `data`:

```json
{
  "ok": false,
  "command": "render",
  "error": { "code": "unverified_changes", "message": "what went wrong", "hint": "what to do about it", "details": {} }
}
```

Branch on `error.code`, not on the message.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error — a bug in sartor |
| 2 | Usage — unknown command or flag, missing argument |
| 3 | Bad input — a file is missing, unreadable, or does not match its schema |
| 4 | Provider — no API key, rejected key, rate limit or network (`*run` commands only) |
| 5 | Blocked — an accepted change is unverified, or the PDF exceeds the page target |

## Commands

Any file argument may be `-` to read stdin.

Write a prompt to a file with `--out`, never with a shell redirect (`> file`). The prompt file holds the payload itself — `task`, `instructions`, `input`, `schema`, and `next`, the command to run on what you write — and stdout reports where it went. A redirect makes the command more than a `sartor` call, so a `Bash(sartor *)` permission does not cover it and the agent is asked to approve it.

| Command | What it does |
|---|---|
| `sartor extract <resume>` | Text from a PDF, DOCX or text resume. `--out` writes it to a file. |
| `sartor ingest prompt <resume> [--out]` | Instructions, resume text and schema for structuring a resume. `--out` writes them to a file. |
| `sartor ingest apply <structured.json>` | Validates a structured resume and writes `--out profile.json`. |
| `sartor ingest run <resume>` | Structures a resume with a provider API key. |
| `sartor tailor prompt --profile --posting [--pages] [--template] [--tone] [--seniority] [--out]` | Instructions, input and schema for a tailoring plan. `--out` writes them to a file. `--template` sets the summary's length in characters; pass the one you will apply with. |
| `sartor tailor apply --profile --posting --plan [--pages] [--template] [--out run.json]` | Validates the plan, fits it to the page, checks it, writes a run file. Warns when the summary prints on more lines than the page target allows (3 on one page, 4 on two). |
| `sartor tailor run --profile --posting [--pages] [--template] [--provider] [--model]` | The same, making the model call with a provider API key. |
| `sartor review <run.json> [--accept] [--reject] [--acknowledge] [--accept-rest] [--detailed]` | Lists changes by number; records decisions in the run file. |
| `sartor render <run.json> [--format pdf\|docx\|txt] [--template] [--out]` | Writes the resume. Refuses while an unverified change is accepted. |
| `sartor check <run.json>` | Unverified changes, page estimate, parse safety, posting coverage. |
| `sartor schema <profile\|plan\|structured-resume>` | A JSON Schema. |
| `sartor templates` | The templates, densest to roomiest. |

`--help` after any command describes it.

## Changes

`review` numbers every change the run makes to the profile:

| Kind | Meaning |
|---|---|
| `bullet-drop` | A bullet left off this resume (it stays in the profile) |
| `entry-drop` | A whole role or project left off |
| `bullet-text` | A bullet reworded |
| `summary` | The summary written for this posting |
| `skills` | Skill groups or keywords chosen and ordered |
| `section-order` | Sections reordered |

All start accepted and unreviewed. `--reject N` restores that line to the profile's version. A change with `unverified` tokens uses a name or number the profile does not contain; `--acknowledge N` records that the person vouched for it, and only they can.

## Provider keys

The `*run` commands read keys from the environment, never from flags: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY`. The agent workflow (`*prompt` / `*apply`) needs none.

## The run file

`tailor apply` and `tailor run` write a `sartor.run/1` file holding the profile the plan was made against, the posting, the fitted plan, the model's original plan, and every change with its review state. Later commands read only this file. Do not edit it by hand.
