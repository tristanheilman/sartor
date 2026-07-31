# Architecture

## The central idea: the master profile is a superset

Most resume tools treat *the resume* as the document of record. You edit it, and
when you need a different version you copy it and edit the copy. Within a few
applications you have five diverging files, none of which is authoritative, and
the good phrasing you wrote for one job is stranded in a file you will never open
again.

Sartor inverts that. The document of record is the **master profile**: a
structured, append-only, lossless record of *everything you have ever done*,
whether or not it belongs on any particular resume. It is not a resume and is
never rendered as one.

**Tailoring is a selection-and-emphasis operation over that superset.** A
tailored resume is a projection: a subset of entries, a subset of bullets, an
ordering, and a choice of phrasing. It is derived, disposable, and reproducible.

Three consequences follow, and they are the reason the rest of the design works:

### 1. Fabrication becomes checkable

If the resume is authored, "did the model make this up?" is a question about
intent, and unanswerable. If the resume is *selected from a known superset*, it
becomes a set-membership question: is every proper noun and every number in the
output present in the source? That is mechanical, fast, and has no false
negatives of the kind that matter.

The anti-fabrication guarantee is not a prompt-engineering achievement. It is a
consequence of the data model.

### 2. Diffing becomes meaningful

Because every output element carries the ID of the profile element it derives
from, the diff view is not comparing two documents — it is comparing each
generated line against its own source. That is why rejecting one change reverts
exactly one line, with no regeneration and no risk of the rest of the document
shifting while you review.

### 3. The profile improves with use

When you accept a rephrasing, it is appended to that bullet's `variants` array:
an alternate wording of the same underlying fact, tagged with the job it was
written for. Your canonical text is never overwritten. Next time, the model sees
your accumulated phrasings and can reuse one verbatim instead of inventing a new
one. The superset gets richer; nothing is ever lost.

This is why `variants` is on the bullet rather than on the tailored output, and
why the profile is append-only. Both are load-bearing.

---

## Data flow

```
  resume file
      │  pdfjs / mammoth          (in-browser, file never uploaded)
      ▼
  raw text
      │  one LLM call → structured fields
      ▼
  [ USER CONFIRMS ]               ← mandatory; parsing is imperfect
      ▼
  ┌─────────────────┐
  │ MASTER PROFILE  │  IndexedDB. Append-only. Lossless.
  └────────┬────────┘
           │
  job      │  one LLM call: profile + JD + constraints
  posting ─┤
           ▼
      TailorPlan                  ← IDs only. Never a document.
           │
           │  validatePlan()      ← drops anything with no real source ID
           ▼
      Change[]                    ← guard-checked at creation, per change
           │
           │  [ USER REVIEWS ] accept / reject, individually
           ▼
      buildDocument()             ← pure function of (profile, plan, decisions)
           │
      ResumeDocument              ← plain data. The model never sees this.
           │
       ┌───┴───┐
       ▼       ▼
     PDF     DOCX                 ← deterministic renderers
```

The one-way arrow from plan to document is the important part. **The LLM never
renders anything.** It cannot emit LaTeX, HTML, or markup that becomes the
artifact, because the only thing it is allowed to return is a set of IDs and
strings that a deterministic function turns into a document. That is also why
the PDF and DOCX can never drift apart: they are two renderers over one model.

---

## Module map

```
src/
  core/
    schema.ts          Profile types + zod validation (extends JSON Resume)
    ids.ts             Prefixed, self-describing IDs
    provider/          LLMProvider interface + anthropic / openai / google
    tailor/
      plan.ts          What the model is allowed to return, + JSON Schema
      prompt.ts        System prompt (defence layer 1) + user prompt
      run.ts           One call in, one reviewable run out; plan validation
      lexicon.ts       Tokenisation — the hard part of the guard
      stopwords.ts     Why rephrased verbs are not flagged
      guard.ts         Fabrication guard (defence layer 2)
      coverage.ts      Honest signals; deliberately no score
      apply.ts         Plan → changes → document; variant write-back
    parse/
      extract.ts       PDF/DOCX/text extraction, in-browser
      ingest.ts        Raw text → structured profile, needs confirmation
    render/
      model.ts         ResumeDocument — the deterministic render model
      templates.ts     Three templates, one set of structural rules
      pdf.tsx          @react-pdf/renderer
      docx.ts          docx
      parseSafety.ts   Checkable properties (defence against fake scores)
    jd/
      normalize.ts     Paste + HTML → JobDescription
      ats.ts           Greenhouse / Lever / Ashby public JSON
  storage/
    db.ts              IndexedDB: profiles + run history. Re-validates on read.
    keys.ts            sessionStorage only. Never disk.
  ui/                  React. Knows nothing about which provider is in use.
extension/             MV3 scaffold (phase 2)
```

---

## Design decisions worth defending

### Why no server-side scraping proxy

LinkedIn, Indeed, and Workday do not publish job JSON, so the obvious move is a
proxy that fetches and parses their pages. It is the wrong move:

- It puts bandwidth cost and legal exposure on whoever operates a deployment.
- It breaks the zero-infrastructure claim that the entire privacy argument rests
  on. Once there is a server, "your data never touches our servers" is false.
- It loses to Cloudflare and datacenter-IP blocking anyway, so the maintenance
  cost is permanent and the success rate declines.

The correct answer is a browser extension: the user already loaded the page, in
their own session, from their own IP. No proxy, no cost, no bot-detection fight,
and no scraping. See `extension/README.md`.

### Why the guard has two severity levels

At the start of a sentence there is no morphological difference between
"Directed" (a legitimate rephrasing of "Led") and "Datadog" (a fabricated
employer). Flagging every rephrased opener would make the guard so noisy it would
be ignored — which is a worse outcome than a calibrated guard.

So: anything with proper-noun shape (acronym, internal capital), anything
capitalised mid-sentence, and anything containing a digit is `high` severity and
checked strictly, wherever it appears. A capitalised sentence-opener that is not
in the common-English list is `medium`. Both block export; the severity tells you
how hard to look.

### Why storage re-validates on read

`listProfiles()` runs every stored record back through the zod schema and drops
anything that fails. A schema migration or a corrupted record should surface at
the storage boundary, not three screens later inside a PDF renderer with a stack
trace nobody can act on.

### Why `prefault` and not `default`

In zod 4, `.default({})` substitutes the value verbatim without running it
through the inner schema, so `basics: basicsSchema.default({})` leaves every
field `undefined` at runtime for any profile that omits the object. `.prefault({})`
parses it. This was caught by a test, and it would have crashed the renderers on
the first hand-built profile.

---

## Testing

159 tests. The ones that matter most:

- **`guard.test.ts`** — tokenisation of real-world resume tokens, and the
  precise boundary between allowed rephrasing and fabrication.
- **`apply.test.ts`** — that rejecting one change reverts exactly one line, that
  invented skill keywords are discarded even when the change is accepted, that
  write-back never overwrites canonical text or duplicates a phrasing.
- **`schema.test.ts`** — that a bullet cannot exist without an ID, and that
  `validatePlan` discards hallucinated employers and orphan bullets.
- **`render.test.ts`** — renders an actual PDF and an actual DOCX for all three
  templates. Both libraries validate at render time, so this is the only way to
  catch an invalid style prop.
- **`provider.test.ts`** — intercepts `fetch` to pin each provider's request
  shape without needing a key: that Anthropic's browser-access header is
  actually sent, that each provider constrains output to our schema in its own
  dialect, and that a streamed response is assembled correctly. The failure it
  exists to catch is an SDK upgrade silently changing a request shape, which
  would otherwise surface as a 400 in a user's browser.
- **`db.test.ts`** — that reads re-validate (a corrupted record must not reach
  a renderer) and that deleting a profile also deletes its run history.
- **`App.test.tsx`** — that the app mounts, that the key lands in
  `sessionStorage` and not `localStorage` or a cookie, that it is never
  rendered in full, and that erasing data does not strand the user on a step
  the nav has just disabled.
