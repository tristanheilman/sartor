# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The web app.** A static, browser-only resume tailor with no server, account
  or telemetry. Keep one master profile in your browser, import an existing
  resume from PDF or DOCX, paste a job posting (or a Greenhouse, Lever or Ashby
  link), pick a one- or two-page target and a template, and review every
  proposed change as a word-level diff before exporting to PDF or DOCX. Accepted
  rewordings are saved back to the profile as variants, and every run is kept in
  local history so it can be reopened and re-exported without another model
  call. Bring your own key for Anthropic, OpenAI or Google; the key lives in
  session storage and is erased when the tab closes.
- **The `sartor` library.** The app's building blocks published as an ESM
  package with four entries: `sartor` for the schema, tailoring, guard,
  coverage, providers and the document model; `sartor/parse` for resume
  ingestion; and `sartor/render/pdf` and `sartor/render/docx` for the two
  renderers. The main entry depends only on `zod`; the PDF, DOCX and parsing
  engines are optional peers so a DOCX-only consumer never downloads a PDF
  engine.
- **The fabrication guard.** The model returns a selection plan, not a
  document, and every element in it must point at an element of your profile.
  Anything that does not is discarded before it can be rendered. Every proper
  noun and number in generated text is then checked against a lexicon built
  from your whole profile, with a tokeniser that understands `Node.js`, `C++`,
  `CI/CD`, `40%` and date forms. A flagged change blocks export until you reject
  it or vouch for the fact yourself. Available on its own as `buildLexicon` and
  `checkText` for any grounded-generation use.
- **Coverage signals instead of an ATS score.** Three honest lists for each
  run: posting terms that appear in the tailored resume and where, terms in your
  profile that this version left out (restorable with one click), and terms
  that appear nowhere in your profile. A parse-safety checklist reports the
  document's real properties, such as single-column layout and selectable text.
  No 0–100 score is shown, because one would be invented.
- **The command-line tool.** The same pipeline as `sartor` commands for an
  agent to drive: `extract`, `ingest prompt` / `ingest apply`, `tailor prompt` /
  `tailor apply`, `review`, `render`, `check`, `schema` and `templates`, plus
  `ingest run` and `tailor run` for calling a provider with your own key. Every
  command prints one JSON envelope, never prompts, and fails with a stable error
  code, a hint and a distinct exit code. Optional engines are loaded on demand,
  and a missing one is reported with the install line to fix it.
- **Claude Code plugin.** Two skills, `import-resume` and `tailor-resume`,
  written to the open Agent Skills format and installable from this repository
  with `claude plugin marketplace add tristanheilman/sartor`. The agent writes
  the structured resume and the tailoring plan itself, so no API key is needed.
  A full CLI reference ships with the skills.
- **`--out` on the prompt commands.** `ingest prompt` and `tailor prompt` can
  write their prompt payload to a file instead of stdout, so an agent with a
  `Bash(sartor *)` permission is not asked to approve a shell redirect.
- **A summary line budget.** The professional summary is held to three printed
  lines on a one-page resume and four on two pages. The tailoring prompt states
  that limit in characters for the chosen template, and `tailor apply` and the
  app warn when the summary runs over, since every extra line is room a bullet
  could have had.
- **Sample data.** A sample master profile, job posting and plan in `examples/`
  so a newcomer can run a full tailor-and-export without entering their own
  details.

### Fixed

- **Resumes now fit the page they were asked to fit.** The model never reliably
  honoured a length budget in the prompt, so the plan is now fitted in code
  using the chosen template's own measurements. Bullets are trimmed from the end
  of the model's ranking when the page runs long and put back from the profile
  when it runs short, with no rewriting and no invention. Roles are never
  dropped whole, every role keeps at least one bullet, recent roles get a
  second bullet before older ones, no role grows past six, and a project left
  as a one-line stub is removed outright. The line count comes from the
  renderer's own line breaking, so a long bullet is no longer counted as three
  lines when it prints on two, and the trim-and-fill no longer oscillates
  between runs.
- **The right project survives the cut.** Projects were ranked for trimming by
  how many words they shared with the posting, which kept a wordy full-stack
  app as a stub and cut the open-source libraries the posting had actually
  asked for. Off-topic projects go first; among on-topic ones the model's own
  first choice is held back until everything else is gone. A project the
  posting asked for that the model excluded is put back when there is room.
- **Skills groups are ranked by the posting's terms, not word overlap.** A group
  that spelled out a technology and its services was scoring below a generic
  group that merely shared common words, and was cut first. Groups are now
  worth the stated requirements they carry, and a group that is the only
  evidence on the page for a claim the summary makes is kept so the summary is
  never left naming something the page does not show. A skills line with
  bracketed sub-lists such as `AWS (Lambda, S3)` is also split at the right
  commas instead of into fragments.
- **Coverage reads postings the way they are written.** A fixed character
  window after each cue phrase ran one bullet into the next and could not see a
  cue that followed its term, so "Deep PostgreSQL knowledge — required" was
  missed and degree words were reported as requirements. Requirement lines are
  now read whole, including paragraphs hard-wrapped by a paste; postings
  written as prose are recognised; a "Nice to have" section no longer promotes
  its contents to hard requirements; the hiring company named in the title
  line is no longer listed as a skill you lack; and two-word names such as
  "React Native" count as one term rather than two.
- **Coverage no longer reports a skill you have as a gap.** Terms are matched
  across grammatical forms, so a posting that asks for "Sharding" is satisfied
  by a profile that says "Resharded", without loosening the fabrication guard,
  which keeps its stricter matching. A term named only in the summary is
  listed but no longer counted as shown on the page.
