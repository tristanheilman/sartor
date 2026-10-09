---
name: tailor-resume
description: Tailor a resume to a specific job posting with the sartor CLI — choosing and ordering the person's own bullets to fit one or two pages, with every line traceable to their profile and nothing invented. Use when the user wants their resume tailored, targeted or fitted to a job posting, or wants a one-page or two-page version of their resume for a particular role.
license: MIT
compatibility: Requires the sartor CLI (Node 20.19 or later) on PATH. Runs locally; no API key is needed when the agent writes the plan.
allowed-tools: Bash(sartor *) Read
metadata:
  author: tristanheilman
  version: "0.1.0"
---

# Tailor a resume to a job posting

You do the judgement: which of the person's bullets answer this posting, and in what order. `sartor` does everything mechanical and enforces the guarantees — it validates your plan against the profile, fits it to the page using the renderer's own measurements, checks every generated line for names and numbers the profile does not contain, and refuses to render one that fails.

The product's promise to the person is: **nothing invented, nothing silently rewritten, every change shown to them.** Keep it.

## Before you start

1. Run `sartor --version`. If it is not found, stop and tell the person how to install it — see [references/cli.md](references/cli.md#installing).
2. You need three things. Ask for whatever is missing rather than guessing:
   - **A profile** (`profile.json`). If they only have a resume file, use the `import-resume` skill first.
   - **The job posting**, saved as a text file (`posting.txt`). Paste in the whole posting.
   - **The page target**: 1 or 2. Default to 1 if they have no preference.
3. Optionally a template (default `classic`); `sartor templates` lists them. Denser ones (`compact`, `serif-compact`) hold more on one page.

## Steps

1. **Get the task.** Write it to a file and read that — it is long:

   ```bash
   sartor tailor prompt --profile profile.json --posting posting.txt --pages 1 --out tailor-prompt.json
   ```

   The file has `task`, `instructions`, `input` (the profile and posting), `schema`, and `next` — the command to run once you have written the plan. Use `--out` rather than a shell redirect: a redirect is not covered by the skill's permission to run `sartor`.

2. **Write the plan** to `plan.json`: JSON matching the file's `schema` exactly, following its `instructions`. In particular:
   - Select and order only. Every `bulletId` and entry `id` must come from the profile.
   - Include **more than fits** — about twice what the page holds, ranked best first within each entry, and projects ranked by how well they answer the posting. The fit pass trims from the end of your order, so ranking is what decides what survives.
   - List in `requested` any project that is an example of something the posting explicitly asks for — not one that merely shares a technology with it. Never set `include: false` on those.
   - Leave each bullet's `text` empty with `textSource: "canonical"` so the person's own wording is used. Reword only if the person asked for it; every rewording is flagged for their review.
   - Never add a skill, tool, employer, title, date, credential or number the profile lacks. If the posting asks for something the profile cannot support, say so in `notes` instead.

3. **Apply it:**

   ```bash
   sartor tailor apply --profile profile.json --posting posting.txt --plan plan.json --pages 1 --out run.json
   ```

   If it fails with `invalid_plan`, `error.details.issues` says which field is wrong — fix that and re-run. Read `data.estimate` (pages and fill) and every `warnings` entry.

4. **Show the person the changes.** Run `sartor review run.json` and present the numbered list in plain words. Ask which they want to reject. Then:

   ```bash
   sartor review run.json --reject 3,7
   ```

   A change listing `unverified` words uses a name or number the profile does not contain. Reject it — unless the person tells you it is true, in which case `--acknowledge` it. Never acknowledge one on your own judgement.

5. **Check, then render:**

   ```bash
   sartor check run.json
   sartor render run.json --format pdf --out resume.pdf
   ```

   `check` and `render` exit with code 5 when something blocks: an unverified change still accepted, or a PDF longer than the target. Follow `error.hint`.

6. **Report back**: where the file is, its page count, which of the posting's requirements are on the page and which the profile could not support (`sartor check` lists both).

## Rules

- Never edit `run.json` or `profile.json` by hand to get past a check. The checks are the point.
- Never claim experience the profile does not show, in the plan, the summary, or your reply.
- If `tailor apply` warns that the page does not fit even when trimmed, offer a denser template or a 2-page target rather than cutting further yourself.

For every command, flag, output field and exit code, see [references/cli.md](references/cli.md).
