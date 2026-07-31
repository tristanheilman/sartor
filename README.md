# Sartor

**Your resume never leaves your browser, and the model cannot invent things you did not do.**

Those are the two claims this project exists to make good on. Everything else is
a feature list.

---

## The privacy architecture

Sartor is a static site. Not "a static site with a small API" — a static site.
There is no server, no database, no account, and no telemetry. When you deploy
it, you are deploying HTML, CSS, and JavaScript to a CDN, and nothing else.

That constraint is what makes the privacy claim literally true rather than a
promise:

| What | Where it lives | Who can see it |
| --- | --- | --- |
| Your master profile and tailoring history | IndexedDB, in your browser | You |
| Your API key | `sessionStorage`, in this tab, erased when the tab closes | You |
| Your resume text | In memory, and in IndexedDB | You |
| Model calls | Browser → your chosen provider, directly | You and that provider |

There is no step in which a server belonging to this project receives your
resume, because there is no server belonging to this project. You bring your own
API key, and the only network requests the app makes are to the provider you
picked and to the ATS job boards you explicitly paste a link from.

### The honest caveat

A key held in a browser can be read by any script running on the page. That is
unavoidable in a zero-backend design, and it is the trade this project makes
deliberately: the alternative is a server that holds your key *and* sees your
resume, which is strictly worse for the thing most people actually care about.

The mitigations are real but worth stating plainly rather than burying:

- The app ships **no third-party scripts, fonts, analytics, or CDN requests**.
  The only code on the page is code in this repository.
- The key goes to `sessionStorage`, never `localStorage` and never disk, so
  closing the tab erases it.
- Provider SDKs require you to opt in to browser use explicitly — Anthropic via
  the `anthropic-dangerous-direct-browser-access` header, OpenAI via
  `dangerouslyAllowBrowser`. Those names are warnings, and they are accurate.
- Use a scoped key with a spend limit, and revoke it when you are done.

If you are not comfortable with that trade, don't use a browser-based BYOK tool
— this one or any other.

---

## The anti-fabrication guarantee

The model may **reorder, reweight, re-emphasise, and rephrase**. It may **never**
introduce a skill, employer, date, title, technology, or metric that is not
already in your master profile.

This is enforced three ways, structurally, not by asking nicely:

**1. Provenance is required.** The model never writes a document. It returns a
selection plan in which every element carries the ID of the profile element it
derives from. Anything pointing at an ID that does not exist is discarded before
it can reach a renderer — a hallucinated employer cannot get onto the page even
if its wording is flawless.

**2. Every proper noun and every number is checked.** Generated text is
tokenised and each proper noun and numeric token is looked up against a lexicon
built from your entire profile. The tokeniser understands the things resumes
actually contain: `Node.js`, `C++`, `CI/CD`, `.NET`, `Google's`, `40%` matching
`40`, `APIs` matching `API`, `2024` matching `2024-11`.

**3. Violations block export.** A flagged change cannot be exported. You either
reject it — which restores your original wording, with no regeneration — or tick
a box confirming the fact is genuinely yours and your profile just doesn't
mention it yet. A warning you can click past is a warning that gets clicked
past, so this one you can't.

The guard is deliberately calibrated. Rephrasing is *allowed*, so an ordinary
English verb at the start of a line ("Directed the migration") is not flagged
just because your profile said "Led". A capitalised word that is not ordinary
English, an acronym, an internal capital, or anything containing a digit is
checked strictly, wherever it appears.

---

## No fake ATS score

Sartor will not show you a 0–100 "ATS score", because such a number would be
invented.

The widely-repeated claim that ATS software automatically rejects 75% of resumes
is not supported by evidence — it traces to vendor marketing, not research — and
in practice only a small minority of employers configure content-based automatic
rejection at all. A made-up score would give false precision and push you toward
keyword stuffing, which makes the document worse for the human who eventually
reads it.

Instead you get three lists you can actually check, and a checklist of the
document's real properties:

- **In your resume** — which terms from the posting appear, and in which section.
- **In your profile, but not this version** — things you have that got cut. One
  click in Review brings them back.
- **Not anywhere in your profile** — genuine gaps. The tool will not manufacture
  these for you, and says so.

The parse-safety checklist covers what actually breaks text extraction:
single-column layout, real selectable text, standard headings, contact details
in the document body rather than a page header, no tables or text boxes. Items
the template guarantees are labelled as such; the rest are computed from your
document.

---

## How it works

1. **Import once.** Upload a PDF or DOCX. Text is extracted in your browser
   (`pdfjs-dist` / `mammoth`), and one model call turns it into structured
   fields. You review and correct those fields before anything is saved — parsing
   is imperfect, and a silent error here would quietly poison every resume you
   ever tailor from it.
2. **Paste a posting.** Or paste a Greenhouse, Lever, or Ashby link and it will
   be fetched from their public JSON.
3. **Tailor.** One call. The model returns a plan, not a document.
4. **Review.** An inline word-level diff, change by change, each with its
   rationale. Accept or reject individually; rejecting never regenerates anything.
5. **Export.** PDF and DOCX, rendered deterministically from the same document
   model, so the two can never disagree.

Accepted rephrasings are written back into your master profile as *variants* —
alternate wordings of the same underlying fact. Your original text is never
overwritten. The profile gets richer the more you use it.

Every run is kept in browser storage, so reopening a previous tailoring — to
re-export it, or to reuse it for a similar posting — is a local read that costs
nothing and calls no model.

---

## Running it

Requires Node 20.19+.

```sh
npm install
npm run dev          # http://localhost:5173
npm test             # 161 tests
npm run build:app    # static site  -> dist-app/
npm run build:lib    # npm package  -> dist/
```

Deploying is copying `dist-app/` to any static host. A GitHub Pages workflow is
included at `.github/workflows/deploy.yml`; it sets `BASE_PATH` for you. For a
root-path deploy (Cloudflare Pages, Netlify, S3), the default `BASE_PATH=/` is
already correct.

### Providers

Ships with Anthropic, OpenAI, and Google. All model access goes through a single
`LLMProvider` interface, so adding a provider is one new file plus one line in
the registry — it touches no application logic. A future hosted mode, where a
server holds the key, is just another implementation of that interface rather
than a rewrite.

---

## Using it as a library

The pieces this app is built from are published as `sartor`. The main entry
needs only `zod`; the heavy parts sit behind subpaths so using the guard does
not pull a PDF engine into your bundle.

```sh
npm i sartor
```

```ts
import { buildLexicon, checkText } from 'sartor';

// Nothing here is resume-specific. `buildLexicon` takes any JSON-like source
// and `checkText` reports proper nouns and numbers that are not grounded in it
// — as useful for summarisation or RAG output as it is for resumes.
const lexicon = buildLexicon(sourceDocuments);
const { violations } = checkText(modelOutput, lexicon);
// [{ token: 'Kubernetes', kind: 'proper-noun', severity: 'high', ... }]
```

| Entry | Contains | Optional peers |
| --- | --- | --- |
| `sartor` | schema, tailoring, guard, coverage, providers, the document model | — |
| `sartor/parse` | resume ingestion | `pdfjs-dist`, `mammoth` |
| `sartor/render/pdf` | PDF renderer | `react`, `@react-pdf/renderer` |
| `sartor/render/docx` | DOCX renderer | `docx` |

The two renderers are separate entries on purpose: offering both output formats
should not mean shipping both engines. A DOCX-only consumer installs `sartor`,
`docx` and `zod`, and never downloads the PDF engine.

Two things worth knowing. `ResumeDocument` is exported from the **main** entry,
not from a render subpath, so you can write your own renderer without depending
on either of ours. And `extractResumeText` needs you to pass `pdfWorkerSrc` — there is no
portable way for a library to locate the pdf.js worker, so the bundler-specific
incantation stays in your application code where it belongs.

ESM only. Everything exported from the three entry points is covered by semver;
anything reachable by deep import into `dist/` is not.

---

## Status

Working end to end: profile management, resume import, tailoring, the
fabrication guard, coverage signals, diff review with write-back, run history,
and PDF/DOCX export. Greenhouse/Lever/Ashby URL loading works subject to their CORS policy,
which changes without notice — paste always works and is the default.

The browser extension is scaffolded but not implemented. See
[`extension/README.md`](extension/README.md) for why that is the right answer for
LinkedIn, Indeed, and Workday, and why a server-side scraping proxy is not.

Architecture notes, including the master-profile-as-superset idea that the whole
design rests on, are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

MIT licensed.
