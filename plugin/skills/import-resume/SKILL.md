---
name: import-resume
description: Turn a resume file (PDF, DOCX or plain text) into a structured Sartor profile — the master record every tailored resume is selected from — using the sartor CLI. Use when the user wants to import, parse or set up their resume for tailoring, or has a resume file but no profile.json yet.
license: MIT
compatibility: Requires the sartor CLI (Node 20.19 or later) on PATH. Runs locally; no API key is needed.
allowed-tools: Bash(sartor *) Read
metadata:
  author: tristanheilman
  version: "0.1.0"
---

# Import a resume into a profile

The profile is the person's document of record: everything they have done, transcribed from their resume. Every tailored resume is selected from it, and the fabrication check measures against it — so a mistake here quietly affects every resume made from it. Transcribe; do not write.

If `sartor --version` fails, the CLI is not installed. It is not on npm yet; install it from a clone: `git clone https://github.com/tristanheilman/sartor.git && cd sartor && npm install && npm run build:lib && npm link` (Node 20.19 or later).

## Steps

1. **Get the task**, written to a file because it carries the whole resume:

   ```bash
   sartor ingest prompt resume.pdf --json > ingest-prompt.json
   ```

   `data` has `task`, `instructions`, `input` (the resume text) and `schema`. If it fails with `extract_failed`, the file may be a scan with no text; ask the person for a PDF exported from their editor, or a `.txt` copy.

2. **Write `structured.json`**: JSON matching `data.schema` exactly, following `data.instructions`:
   - Copy text as literally as you can. Fix only extraction damage, such as a word split across a line.
   - One accomplishment per bullet. Never merge, improve, shorten or summarise a bullet.
   - Never infer a date, number or name the resume does not state. Leave the field `""` instead.
   - Every field is required; use `""` or `[]` when the resume has nothing for it.

3. **Apply it:**

   ```bash
   sartor ingest apply structured.json --out profile.json
   ```

   If it fails with `invalid_structured_resume`, `error.details.issues` names each wrong field. Fix them and re-run.

4. **Have the person check it.** Tell them what was read (`data.profile`: name, roles, projects, bullets) and every warning, and ask them to compare names, dates and numbers against the original. Change only what they tell you to change.

Then the profile is ready for the `tailor-resume` skill.
