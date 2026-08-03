# Getting content *into* the master profile

Status: design, not built. Two features that are really one pipeline.

## The problem

The master profile is a superset of everything you have done, and tailoring is
a projection over it (see `ARCHITECTURE.md`). That works — but today the
superset can only be created, never grown:

- `ImportPanel` renders only when `!editing` (`App.tsx:123`). Once a profile is
  saved there is **no import path at all**. It is a create-only flow.
- Ingest is deliberately a transcriber — `INGEST_SYSTEM_PROMPT` says "You are
  transcribing, not writing… Never invent, infer, embellish." Right for parsing
  a resume you already wrote, but it means there is no authoring mode anywhere.
- So a year of new work means hand-typing into `ProfileEditor`.

This is a real hole rather than an oversight. The fabrication guard assumes
facts enter through exactly one door — confirmed ingest. Anything that adds
content needs its own door with the same mandatory-confirmation property.

## The shape

Both features below are the same pipeline with different front ends:

```
  a file            a GitHub repo
      │                   │
      │ extract+ingest    │ read evidence → one LLM call
      ▼                   ▼
  partial Profile     candidate entries + bullets
      │                   │          each carrying provenance
      └─────────┬─────────┘
                ▼
          planMerge(existing, incoming)     ← deterministic. no LLM.
                ▼
          [ USER CONFIRMS, per candidate ]  ← mandatory
                ▼
          applyMerge()                      ← pure. append-only.
                ▼
          MASTER PROFILE
```

Merge is the load-bearing part and is worth building first: it is useful on its
own, and the GitHub feature is unshippable without it.

---

# Part 1 — Merge-import

## New module: `src/core/parse/merge.ts`

Deterministic, no LLM, pure functions. Cheap to run, and testable the way the
rest of `core` is testable.

```ts
export type MergeAction = 'add' | 'merge' | 'skip';

export interface MergeCandidate<T> {
  incoming: T;
  /** Best existing match, if any. */
  match: { id: string; confidence: number; reason: string } | null;
  /** What we recommend. The user can always override. */
  suggested: MergeAction;
}

export interface BulletMerge {
  incoming: Bullet;
  /** Set when this is a rewording of a bullet already on the entry. */
  duplicateOf: string | null;
  similarity: number;
}

export interface ProfileMerge {
  work: MergeCandidate<WorkEntry>[];
  projects: MergeCandidate<Project>[];
  education: MergeCandidate<Education>[];
  skills: MergeCandidate<SkillGroup>[];
  certificates: MergeCandidate<Certificate>[];
  awards: MergeCandidate<Award>[];
  /** Field-level, because basics are overwritten not appended. */
  basics: Array<{ field: keyof Basics; current: string; incoming: string }>;
}

export function planMerge(existing: Profile, incoming: Profile): ProfileMerge;
export function applyMerge(
  existing: Profile,
  merge: ProfileMerge,
  decisions: Record<string, MergeAction>,
): Profile;
```

## Matching rules

Deliberately boring and explainable, because a wrong merge silently corrupts the
document of record.

| Section | Strong match | Weak match |
|---|---|---|
| Work | normalised company **and** overlapping date range | company only |
| Projects | normalised name, or same `url` | name similarity |
| Education | institution **and** area | institution only |
| Skills | normalised group name | — |

Strong match → suggest `merge`. Weak → suggest `add`, flagged for a look. No
match → `add`.

**Reuse `tailor/lexicon.ts` and `stopwords.ts` for the text comparison.** They
already solve resume-token normalisation for the guard, and a second, subtly
different tokeniser would be a bug farm.

## The nice part: near-duplicate bullets become variants

When a bullet merges into an entry that already has a near-identical bullet,
do not skip it and do not add a duplicate line. Append it to the existing
bullet's `variants` array with `source: 'original'` and a `note` naming the
file it came from.

That is exactly what `variants` is for — "alternate phrasings of the *same
underlying fact*" — and it means re-importing an old resume you had already
polished *enriches* the profile instead of duplicating it. The canonical text is
never touched.

Threshold: Jaccard over content tokens. Start at 0.6, tune against fixtures.

## Invariants to hold (and test)

1. `applyMerge` never mutates or deletes existing canonical bullet text.
2. Every added entry and bullet gets a **fresh ID** from `ids.ts`. Incoming IDs
   from a parsed document are meaningless and must never be trusted — a
   collision would silently re-point a tailored run at the wrong fact.
3. `skip` leaves the profile byte-identical.
4. Merging a profile into itself is a no-op with every bullet detected as a
   duplicate. This is the single best regression test.
5. `basics` is never auto-overwritten. Conflicts are shown field by field.

## UI

- `ProfileStep` gains an "Add from a file" action when a profile exists, routing
  to the existing `ImportPanel`.
- New `MergePanel`, modelled on the ingest confirmation screen: grouped
  candidates, each with Add / Merge into… / Skip, defaulted to `suggested`, with
  the match reason shown. Counts at the top ("6 new bullets, 2 reworded, 1 new
  role").
- Nothing is written until the user commits the whole merge.

---

# Part 2 — GitHub as a content source

## Auth: a fine-grained PAT, not OAuth

Verified, because it decides the whole design:

```
api.github.com                    → access-control-allow-origin: *
github.com/login/oauth/access_token → no CORS header at all
```

So the browser can call the REST API directly, but **cannot complete an OAuth
token exchange** — that includes the device flow, whose polling hits the same
CORS-blocked endpoint. OAuth from a pure SPA needs a backend to hold the client
secret, and a backend falsifies the claim the entire project rests on. Same
reasoning as "why no server-side scraping proxy" in `ARCHITECTURE.md`.

A pasted fine-grained PAT is the honest answer, and it is a *better* posture
than OAuth: read-only, per-repository, user-visible, and expiring. Store it in
`sessionStorage` exactly like the provider key — extend `storage/keys.ts`, keep
`maskKey` for display.

**Known limitation, worth surfacing in the UI rather than hiding:** a
fine-grained PAT is scoped to one resource owner. It can cover your own repos
and an org's repos (if the org has opted in, and after SAML SSO authorisation),
but it **cannot** reach a private repo owned by someone else that you were added
to as a collaborator. That case needs a classic PAT with `repo` scope, which
grants read *and write* to everything you can see. Offer it as an explicit,
clearly warned second option — do not make it the default path.

When the browser extension lands (`extension/`, phase 2), it can do real OAuth,
because an extension can hold a token without a server. That is the upgrade
path, not a reason to build a backend now.

## What we read: `src/core/sources/github.ts`

A typed client over `api.github.com`, plus a `RepoEvidence` type that separates
*what we read* from *what we ask the model*. Precedent exists — `jd/ats.ts`
already fetches third-party JSON straight from the browser.

Data minimisation as an explicit ladder, each tier opt-in:

| Tier | Content | Default |
|---|---|---|
| 1 | name, description, topics, languages, stars, first/last commit, your commit count | on |
| 2 | README, package manifests | on |
| 3 | commit subjects and PR titles **authored by you** | off |
| 4 | source diffs | off, per-repo, with a warning |

Tier 4 sends source code to a model provider. For a work repository that may
breach an employment agreement, and the UI should say so in those words. Rate
limit is 5,000 requests/hour authenticated, which is not a constraint here.

## Proposing content: `src/core/sources/propose.ts`

One LLM call, `RepoEvidence[]` → candidate `Project` entries and bullets, under
a JSON Schema like every other call in this codebase.

**Every generated bullet must carry provenance**: the repo, and the specific
artifact it came from (README section, commit range, PR number), with a URL.
This mirrors the `plan.ts` source-ID rule one layer up, and it converts "did I
actually do this?" from a memory test into a link the user can click while
confirming.

The rule that matters most:

> A repository is evidence of **what you built**, never of **what it was worth**.
> Counts, dates, languages, and dependencies are derivable. Business impact —
> revenue, users, latency, cost — is not. The model must leave impact as an
> explicit blank for the user to fill, never a guess.

Invented metrics are the failure mode that would discredit the whole tool. Note
that the existing guard does **not** protect here: it checks that tailored
output ⊆ profile, so a fabricated number that the user waves through at this
stage becomes "grounded" forever after. Confirmation is the only defence, which
is why provenance has to be in front of the user, not in a debug log.

Output feeds `planMerge` like any other source. GitHub gets no special path into
the profile.

---

## Open decisions

1. **Similarity threshold** for duplicate bullets — needs tuning against real
   resumes, not a guess. Suggest building the merge fixtures first.
2. **Classic PAT**: support it for collaborator repos, or decline and tell the
   user why? Supporting it means asking for a write-capable token in a tool
   whose pitch is safety.
3. **Should generated project bullets be marked?** A `source: 'llm'` marker on
   the bullet (not just the variant) would let the UI show "generated from a
   repo, never edited by you" a year later. Costs a schema field.
4. **Tier 3 by default?** Commit subjects you wrote are the highest-value signal
   per byte, and are arguably already public for public repos.
