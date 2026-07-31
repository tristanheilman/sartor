# Browser extension (phase 2 — scaffold only)

**Status: not implemented.** This directory holds a manifest and the plan. The
web app works fully without it; pasting a job description always works and is the
default path.

## What it is for

Greenhouse, Lever, and Ashby publish public JSON for their job boards, so the web
app can read those postings directly. LinkedIn, Indeed, and Workday do not.
Between them those three carry a very large share of postings, and today the user
has to select the text and paste it.

A Manifest V3 content script solves this properly: it reads the job description
from the page **the user already has open**, in their own browser session, and
hands it to the app.

## Why this and not a server-side scraper

A proxy that fetches and parses those pages server-side is the obvious
alternative, and it is worse on every axis that matters:

| | Extension | Server-side proxy |
| --- | --- | --- |
| Infrastructure | None | A server you run and pay for |
| Zero-infrastructure privacy claim | Intact | **Broken** — there is now a server |
| Bot detection | Not applicable; the user loaded the page | Constant fight with Cloudflare |
| Datacenter IP blocks | Not applicable | A permanent, worsening problem |
| Legal exposure | On the user, who is reading a page they opened | On whoever operates the deployment |
| Cost per posting | Zero | Bandwidth plus maintenance, forever |

The decisive one is the third row. The entire privacy argument for this project
is that there is no server. Adding one to fetch job descriptions would make
"your resume never touches our servers" false — for a feature that is a
convenience over pasting.

This is also not scraping in any meaningful sense: the content script reads a
page the user navigated to themselves, in their own session, and never
automates navigation or collects anything in bulk.

## Planned design

```
extension/
  manifest.json      MV3. activeTab only — no broad host permissions.
  src/
    content.ts       Runs on user gesture. Extracts JD text from the page.
    extractors/      Per-site: linkedin.ts, indeed.ts, workday.ts, generic.ts
    bridge.ts        postMessage to the Sartor tab. Never a remote endpoint.
```

Principles it must hold to:

1. **`activeTab`, triggered by a click.** No background scraping, no persistent
   host permissions, no reading pages the user did not ask about.
2. **Extract only the job description.** Not the user's feed, profile, cookies,
   or anything else on the page.
3. **Hand off locally.** The extracted text goes to the Sartor tab via
   `postMessage`, never to a remote endpoint. The extension has no network
   permissions at all.
4. **Degrade to paste.** Every site extractor is best-effort. When the page
   layout changes — and it will — the app falls back to paste rather than
   silently capturing the wrong text.
5. **Show what was captured.** The extracted text lands in the same editable
   textarea as a paste, so the user sees exactly what will be sent to the model
   before anything is sent.

## Contributing

The highest-value first step is `extractors/generic.ts`: a readability-style
main-content heuristic that works acceptably on most postings, so per-site
extractors become an optimisation rather than a prerequisite.
