import { z } from 'zod';
import { profileSchema, type Profile } from '../schema';
import { ids } from '../ids';
import type { LLMProvider, ProviderConfig } from '../provider';
import type { RepoEvidence } from './github';

/**
 * Repository evidence -> candidate profile entries, via one LLM call
 * (`docs/CONTENT-SOURCES.md`, "Proposing content").
 *
 * The result is a `Profile`-shaped object so it goes straight into `planMerge`;
 * like an imported resume it is a proposal, never saved without the person
 * reviewing it. The saved profile format has no place for provenance, so it is
 * returned alongside, keyed by the bullet's ID.
 *
 * What the model is trusted with is the wording. Everything checkable is
 * checked here: IDs are ours, URLs come from the evidence, and a bullet that
 * states a number the evidence does not contain is dropped.
 */

export const PROPOSE_SYSTEM_PROMPT = `You turn evidence read from a person's GitHub repositories into candidate resume entries.

You are summarising, not embellishing. Rules:

- Write one project per repository, and one to four bullets under it. One
  accomplishment per bullet, past tense, starting with a strong verb.
- State only what the evidence shows. Never infer scale, audience, or quality.
- Business impact — revenue, users, latency, cost, uptime, adoption — is NOT in
  repository evidence. Never estimate it and never write it. Leave it out: the
  person fills it in themselves.
- Use a number only if it appears verbatim in the evidence you were given.
  Do not compute, round, or convert numbers.
- Every bullet names the repo (its full name, "owner/name"), the kind of
  artifact it rests on ("readme", "manifest" or "commits"), and a short
  reference to the specific part: the README section heading, the manifest
  filename, or the commit date range.
- Do not output IDs or URLs; they are added afterwards.
- Skills: group technologies under a name such as "Languages" or "Frameworks",
  using only languages, topics, and dependencies that appear in the evidence.`;

const rawSchema = z.object({
  projects: z
    .array(
      z.object({
        repo: z.string().default(''),
        name: z.string().default(''),
        description: z.string().default(''),
        bullets: z
          .array(
            z.object({
              text: z.string().default(''),
              artifact: z.enum(['readme', 'manifest', 'commits']),
              ref: z.string().default(''),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  skills: z
    .array(z.object({ name: z.string().default(''), keywords: z.array(z.string()).default([]) }))
    .default([]),
});

const S = { type: 'string' } as const;

export const PROPOSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['projects', 'skills'],
  properties: {
    projects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['repo', 'name', 'description', 'bullets'],
        properties: {
          repo: S,
          name: S,
          description: S,
          bullets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'artifact', 'ref'],
              properties: {
                text: S,
                artifact: { type: 'string', enum: ['readme', 'manifest', 'commits'] },
                ref: S,
              },
            },
          },
        },
      },
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'keywords'],
        properties: { name: S, keywords: { type: 'array', items: S } },
      },
    },
  },
} as const;

export type ArtifactKind = 'readme' | 'manifest' | 'commits';

/** Where a proposed bullet came from. */
export interface BulletProvenance {
  /** `owner/name`. */
  repo: string;
  artifact: ArtifactKind;
  /** README section, manifest filename or commit date range, as the model named it. */
  ref: string;
  /** Taken from the evidence, never from the model. */
  url: string;
}

export interface ProposedEntries {
  profile: Profile;
  /** Keyed by bullet ID; every bullet in `profile` has an entry. */
  provenance: Record<string, BulletProvenance>;
  /** What was dropped and why, for the review screen. */
  dropped: string[];
}

/** Digits of every number in `text`, with separators and `%` removed. */
function numbersIn(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map((n) => n.replace(/,/g, '').replace(/\.0+$/, ''));
}

function evidenceText(e: RepoEvidence): string {
  return [
    e.repo.name,
    e.repo.fullName,
    e.repo.description ?? '',
    e.languages?.names.join(' ') ?? '',
    e.topics?.names.join(' ') ?? '',
    e.commits
      ? `${e.commits.firstCommitDate ?? ''} ${e.commits.lastCommitDate ?? ''} ${e.commits.authorCommitCount}`
      : '',
    e.readme?.text ?? '',
    ...(e.manifest ?? []).map((m) => `${m.filename} ${m.text}`),
  ].join('\n');
}

function artifactSource(
  e: RepoEvidence,
  kind: ArtifactKind,
  ref: string,
): { url: string } | null {
  if (kind === 'readme') return e.readme ? { url: e.readme.url } : null;
  if (kind === 'commits') return e.commits ? { url: e.commits.url } : null;
  if (!e.manifest?.length) return null;
  const wanted = ref.trim().toLowerCase();
  const hit = e.manifest.find((m) => m.filename.toLowerCase() === wanted) ?? e.manifest[0]!;
  return { url: hit.url };
}

const month = (iso: string | null) => (iso && /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : '');

export async function proposeFromEvidence(
  evidence: RepoEvidence[],
  provider: LLMProvider,
  cfg: ProviderConfig,
  opts: { label?: string; signal?: AbortSignal; onToken?: (s: string) => void } = {},
): Promise<ProposedEntries> {
  const byRepo = new Map(evidence.map((e) => [e.repo.fullName, e]));

  const result = await provider.complete(
    {
      system: PROPOSE_SYSTEM_PROMPT,
      user: `Propose resume entries from this repository evidence.\n\n---\n${JSON.stringify(evidence, null, 2)}\n---`,
      jsonSchema: { name: 'github_profile_entries', schema: PROPOSE_JSON_SCHEMA },
      signal: opts.signal,
      onToken: opts.onToken,
    },
    cfg,
  );

  const parsed = rawSchema.safeParse(result.json);
  if (!parsed.success) {
    throw new Error(
      `The model returned a structure we could not read (${parsed.error.issues[0]?.message ?? 'unknown'}). Try again.`,
    );
  }

  const provenance: Record<string, BulletProvenance> = {};
  const dropped: string[] = [];
  const projects: Profile['projects'] = [];
  const usedRepos = new Set<string>();
  const knownWords = new Set<string>();

  for (const raw of parsed.data.projects) {
    const ev = byRepo.get(raw.repo.trim());
    if (!ev) {
      dropped.push(`Project "${raw.name || raw.repo}": not one of the repositories read.`);
      continue;
    }
    if (usedRepos.has(ev.repo.fullName)) continue;
    usedRepos.add(ev.repo.fullName);

    const allowed = new Set(numbersIn(evidenceText(ev)));
    const bullets: Profile['projects'][number]['bullets'] = [];
    for (const b of raw.bullets) {
      const text = b.text.trim();
      if (!text) continue;
      const source = artifactSource(ev, b.artifact, b.ref);
      if (!source) {
        dropped.push(`"${text}": cites ${b.artifact} evidence that was not read for ${ev.repo.fullName}.`);
        continue;
      }
      const stray = numbersIn(text).filter((n) => !allowed.has(n));
      if (stray.length > 0) {
        dropped.push(`"${text}": states ${stray.join(', ')}, which is not in the evidence.`);
        continue;
      }
      const id = ids.bullet();
      bullets.push({ id, text, tags: [], variants: [] });
      provenance[id] = { repo: ev.repo.fullName, artifact: b.artifact, ref: b.ref.trim(), url: source.url };
    }

    projects.push({
      id: ids.project(),
      name: raw.name.trim() || ev.repo.name,
      description: raw.description.trim(),
      url: ev.repo.url,
      startDate: month(ev.commits?.firstCommitDate ?? null),
      endDate: month(ev.commits?.lastCommitDate ?? null),
      bullets,
      tags: [],
    });
  }

  for (const e of evidence) {
    for (const w of evidenceText(e).toLowerCase().split(/[^a-z0-9+#.\-_/]+/)) knownWords.add(w);
  }
  const skills = parsed.data.skills
    .map((g) => ({
      id: ids.skill(),
      name: g.name.trim() || 'Skills',
      // A skill the evidence never mentions would be the model's guess.
      keywords: g.keywords.map((k) => k.trim()).filter((k) => k && knownWords.has(k.toLowerCase())),
    }))
    .filter((g) => g.keywords.length > 0);

  const now = new Date().toISOString();
  const profile = profileSchema.parse({
    id: ids.profile(),
    label: opts.label ?? 'GitHub',
    createdAt: now,
    updatedAt: now,
    projects,
    skills,
  });
  return { profile, provenance, dropped };
}
