# Roadmap

## Goal
Sartor is a private, browser-only resume-tailoring tool for individual job
seekers. You keep one master profile, and Sartor builds tailored resumes from it.
Every line is traced back to the profile, a structural guard blocks fabrication,
and the export is a clean PDF or DOCX. No server ever sees the data: you bring
your own model key. Sartor also ships as an npm CLI and as a Claude Code plugin.
Done means a job seeker can get their content in with little typing (from an old
resume, from GitHub, from a job posting in the browser), tailor and export in
minutes, and install the CLI from npm.

## Phases
### Phase 1 — End-to-end tailoring pipeline [done]
Evidence: import, tailoring, the fabrication guard, coverage, diff and review, PDF/DOCX export, run history and the CLI all work end to end. 935 vitest tests pass across 37 files, and the app is live at https://tristanheilman.github.io/sartor/ through `deploy.yml`.
### Phase 2 — A public 0.1 release [current]
Exit when:
- `sartor` 0.1.x is on npm, and `npx sartor --help` runs on a clean machine.
- The README matches what ships: the test count (it still says 161), the feature list, and the browser extension marked as not yet built.
- A CHANGELOG exists.
- The Claude Code plugin installs from the repo by following its README.
### Phase 3 — GitHub as a content source [next]
Exit when:
- A user pastes a fine-grained GitHub token and picks repos, and the app proposes profile entries traced to those repos.
- Those entries merge with existing ones using the similarity rule in `docs/CONTENT-SOURCES.md`.
- That doc's open decisions are made and recorded: the similarity threshold, support for classic tokens, the LLM-provenance marker, and whether tier 3 is on by default.
### Phase 4 — Job postings from the browser [next]
Exit when:
- On a LinkedIn, an Indeed and a Workday posting, the extension in `extension/` sends the posting text into the app, using only the `activeTab` permission and no server.
- The extension loads unpacked by following documented steps.

## Side quests
- Add a `CLAUDE.md` that records the settled build rules: no backend, no path aliases in the library build, and `.prefault` rather than `.default` in zod schemas. Sessions then don't relearn them by breaking things.
- Add a sample master profile and job posting for demos and manual testing. A newcomer can then see a full tailor-and-export run without entering their own data.
- Add a CI check that the CLI commands documented in the README still run. The README is the public contract for the CLI.

## Reserved for the owner
- Publishing to npm or an extension store, and choosing version numbers.
- Anything that sends profile or resume data to a server Sartor runs, or adds a backend.
- How users' model keys and GitHub tokens are stored, and what scope the token asks for.
- Changes to the saved profile or run-history formats that could lose existing data.
- Deleting branches, and changing the licence.

## Settled
- **No ATS score.** Vendor statistics don't support a meaningful one (README, "No fake ATS score").
- **No server-side scraping proxy** for LinkedIn, Indeed or Workday, on grounds of privacy, cost and bot detection (`docs/ARCHITECTURE.md`, `extension/README.md`). The `activeTab` browser extension is the approved route.
- **No OAuth for GitHub as a content source.** CORS rules it out in a pure single-page app, so a pasted fine-grained token is used instead (`docs/CONTENT-SOURCES.md`).
- **No path aliases in the library build**, because they break publishing. Zod schemas use `.prefault`, not `.default`.
