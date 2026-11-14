# Browser extension (phase 4)

Greenhouse, Lever, and Ashby publish public JSON for their job boards, so the
web app can read those postings directly. LinkedIn, Indeed, and Workday do
not. Between them those three carry a very large share of postings, and
without this extension the user has to select the text and paste it.

A Manifest V3 extension solves this properly: on a click, it reads the job
description from the page **the user already has open**, in their own
browser session, and hands it to the app — with no server anywhere in
between.

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

## What was built

```
extension/
  manifest.json              MV3. permissions: ["activeTab", "scripting"]. No host permissions.
  src/
    content.ts                Injected on click. Extracts the posting from the page.
    background.ts             Reads the extraction back and opens the app with it.
    shared.ts                 The `window` key content.ts and background.ts agree on.
    chrome.d.ts                Hand-typed slice of the chrome.* API this extension calls.
    extractors/generic.ts      Readability-style main-content heuristic.
  dist/                       Built output — what manifest.json actually points at.
```

On a click of the toolbar action:

1. The background script injects `content.ts` into the clicked tab —
   permission for this comes from the click itself (`activeTab`), not a
   standing host permission.
2. `content.ts` runs the generic extractor against the page and leaves the
   result on a `window` property; a second, tiny injected function reads that
   property back, since that is the reliable way to get a value out of a
   file-based content script injection.
3. If extraction failed, the action badge turns into a nudge to paste
   instead. Otherwise the background script opens the Sartor app in a new tab
   at `<APP_URL>#posting=<url-encoded JSON>`.

A URL fragment carries the posting with no extra permission, and — because
fragments never leave the browser — it never reaches the GitHub Pages server
the app is hosted on. From there, `src/ui/postingHandoff.ts` on the app side
takes over: it validates the fragment, clears it from the address bar, and
broadcasts the posting over a same-origin `BroadcastChannel`. If a Sartor tab
is already open, that tab acks and loads the posting — it already has a model
key sitting in `sessionStorage`, which a freshly opened tab does not. With no
ack inside about 300ms, the new tab loads the posting itself.

Either way, the posting lands in the same editable textarea a paste would use,
tagged `source: 'extension'`, so the user sees exactly what will be sent
before anything reaches a model.

Principles this holds to:

1. **`activeTab`, triggered by a click.** No background scraping, no
   persistent host permissions, no reading pages the user did not ask about.
2. **Extract only the job description.** Not the user's feed, profile,
   cookies, or anything else on the page.
3. **Hand off locally.** The extracted text goes to the Sartor tab through a
   URL fragment and a same-origin `BroadcastChannel`, never to a remote
   endpoint. The extension has no network permissions at all.
4. **Degrade to paste.** The extractor is best-effort. When a page's layout
   defeats it, the badge says so and the app falls back to paste rather than
   silently capturing the wrong text.
5. **Show what was captured.** The extracted text lands in the same editable
   textarea as a paste, so the user sees exactly what will be sent to the
   model before anything is sent.

## Load it unpacked

1. `npm run build:extension`
2. Open `chrome://extensions`
3. Turn on Developer mode
4. Click "Load unpacked" and select the `extension/` directory

## Contributing

Per-site extractors (LinkedIn, Indeed, Workday) are the highest-value next
step. `extractors/generic.ts` is the fallback every posting can already lean
on, so a per-site extractor is an optimisation rather than a prerequisite.
