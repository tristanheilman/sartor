# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The web app.** A static site with no server, account or telemetry. Import a
  resume from PDF or DOCX, correct the structured fields before anything is
  saved, paste a posting or a Greenhouse, Lever or Ashby link, pick a page
  target and a template, and tailor with your own Anthropic, OpenAI or Google
  key. Review every change as an inline word-level diff, accept or reject each
  one without regenerating, and export PDF and DOCX from one document model so
  the two can never disagree. Accepted rephrasings are written back into the
  master profile as variants, and every run is kept in browser storage so a
  previous tailoring can be reopened without a model call.
- **The library.** Published as `sartor`, with the main entry depending only on
  `zod`. The parser and the PDF and DOCX renderers sit behind the `sartor/parse`,
  `sartor/render/pdf` and `sartor/render/docx` subpaths, so using the guard does
  not pull a PDF engine into a bundle, and a DOCX-only consumer never downloads
  the PDF renderer.
- **The fabrication guard.** The model returns a selection plan, never a
  document, and every element in it must name the profile element it derives
  from. Anything pointing at an ID that does not exist is discarded before it
  can reach a renderer. Every proper noun and number in generated text is
  checked against a lexicon built from the whole profile, with a tokeniser that
  understands `Node.js`, `C++`, `CI/CD`, `.NET`, `40%` and `2024-11`. A flagged
  change blocks export until it is rejected or the person vouches for it.
- **Coverage signals instead of an ATS score.** Three checkable lists for every
  run: the posting's terms that appear in the resume and where, the terms that
  are in the profile but were cut from this version, and the terms that appear
  nowhere in the profile. A parse-safety checklist reports the document's real
  properties, such as single-column layout, selectable text and standard
  headings.
- **Page fitting.** A plan is trimmed to the chosen page target using the
  template's own measurements. Bullets are cut from the end of the plan's
  ranking when the page runs long and put back from the profile when it runs
  short. Roles are never dropped whole, every role keeps at least one bullet,
  and each cut carries a reason the review screen shows.
- **The `sartor` CLI.** The same pipeline from the command line, built for an
  agent to drive: one JSON envelope per command on stdout, a stable error code
  and a hint on every failure, distinct exit codes, and nothing that prompts.
  `ingest prompt` and `tailor prompt` print the instructions, input and schema
  so an agent can do the model's part without an API key, and `ingest apply`
  and `tailor apply` take it from there. `ingest run` and `tailor run` make the
  call with a key from the environment. `extract`, `review`, `render`, `check`,
  `schema` and `templates` round out the workflow, and `render` refuses to write
  a resume while an unverified change is accepted. Optional engines are loaded
  on demand, with an install line in the hint when one is missing.
- **The Claude Code plugin.** Two skills, `import-resume` and `tailor-resume`,
  built on the CLI and written to the open Agent Skills format, installable
  from this repository with `claude plugin marketplace add tristanheilman/sartor`.
- **`--out` for the prompt commands.** `ingest prompt`, `tailor prompt` and
  `extract` write their output to a file with `--out` instead of needing a shell
  redirect, so a `Bash(sartor *)` permission in Claude Code covers the whole
  command and the agent is not asked to approve a redirect.
- **A summary line budget.** The summary may take at most three printed lines
  on a one-page resume and four on two pages. The tailoring prompt states that
  limit in characters for the chosen template, `tailor apply` warns when the
  summary prints over it, and `check` warns when the summary names something
  nothing else on the page shows.
- **A sample profile and posting** in `examples/`, with a ready-made plan, so a
  full tailor-and-export run can be seen without entering your own data or an
  API key.

### Fixed

- **Page fit: the estimate now matches the renderer.** Line widths are measured
  with the real font metrics rather than an assumed average character width,
  which had left nearly three bullets of room unused on a full page. Lines are
  broken the way the PDF renderer breaks them, so a long bullet is no longer
  counted as two lines while the page prints one. Projects are no longer
  charged an employer row they never print, and the last section's bottom
  margin is counted, so a resume the estimate called one page no longer pushes
  its education section onto a second.
- **Page fit: the warning named a remedy that could not work.** The page-fit
  check compared every template against one fixed line count, so switching to
  the Compact template, which the warning itself suggested, changed nothing.
  The check now uses the selected template's own size, leading and margins.
- **Page fit: trimming reported no improvement.** The first fit pass measured
  the document as though nothing had been cut, so it could remove twenty
  bullets and still report the page as full.
- **Page fit: a requested project was cut while unrelated ones stayed.** Cuts
  were ordered by size, which removed every project from a resume for a posting
  that had asked for published open-source libraries while the summary still
  claimed them. Off-topic projects now go first, the posting's first on-topic
  project is held back until every other project is gone, and the bullet budget
  counts project bullets as well as role bullets, so a profile with many
  projects is no longer told it fits when it does not.
- **Page fit: skills groups were cut before the content they backed.** Every
  group with any relevance went before any bullet, so most runs lost all but
  two groups before a single surplus bullet was considered, including the only
  line naming a technology the posting asked for and the summary claimed. A
  group is now weighed against the bullet that would otherwise go, by what each
  alone shows.
- **Skills ranking: detailed groups were penalised for their detail.** Groups
  were ranked by the share of their words the posting also used, so "AWS
  (Lambda, Cognito, S3, CloudWatch)" scored below a group that matched only on
  "development" and "app". Groups are now ranked by the posting's terms they
  carry, with stated requirements counting double.
- **Skills: a skill written with brackets was split into fragments.** Splitting
  on every comma turned "AWS (Lambda, Cognito, S3)" into four entries, which
  then surfaced as questions about "CloudWatch)". Commas inside brackets now
  stay with the group that opened them.
- **Skills: the estimate over-counted the skills line.** Each group was charged
  its own line while the renderer flows them as one paragraph, so the fit
  dropped whole groups to buy back space the page was not spending.
- **Coverage: prose postings came back with no requirements.** Only bulleted
  list cues such as "experience with" were recognised, so a posting written as
  paragraphs ("we want an engineer who…", "you're comfortable…") produced an
  empty coverage report. Prose cues are now recognised too.
- **Coverage: cue words were reported as skills.** "Need Kubernetes and Rust"
  reported "Need" as a required skill, and degree words such as "Deep" in
  "Deep PostgreSQL knowledge" were reported as requirements. Both are now
  excluded.
- **Coverage: Go was no longer recognised as a technology.** Adding "go" to the
  list of ordinary sentence openers had silently stopped it being extracted
  from postings.
- **Guard: ordinary past-tense verbs blocked export.** A bullet rephrased to
  open with "Guarded", "Audited", "Benchmarked" and similar verbs was flagged
  as a possible product name, and since a flagged change cannot be exported,
  the only way out was to reject the rephrasing. These openers are now treated
  as ordinary English.
- **PDF: a hyphen appeared at a line break in the contact and skills lines.** A
  contact line long enough to wrap came out ending "·-", and a Compact export
  printed "NodeJS-" at the end of a skills line. Both separators now break only
  before the dot, with no hyphen.
- **PDF: the name collided with the headline under it.** The name inherited the
  body line height at nearly twice the body size, so the three header lines now
  get their own leading and a real gap.
