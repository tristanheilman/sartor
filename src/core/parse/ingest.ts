import { z } from 'zod';
import { profileSchema, type Profile } from '../schema';
import { ids } from '../ids';
import type { LLMProvider, ProviderConfig } from '../provider';

/**
 * Resume text -> structured profile, via one LLM call.
 *
 * Parsing is imperfect by nature, so the result is *never* saved directly. The
 * caller is required to show it in an editable form and get explicit
 * confirmation first. A silent parse error here poisons every tailoring run
 * that follows, and the fabrication guard cannot help — it would faithfully
 * ground everything in a profile that is already wrong.
 */

export const INGEST_SYSTEM_PROMPT = `You convert resume text into structured JSON.

You are transcribing, not writing. Rules:

- Copy text from the resume as literally as you can. Fix obvious extraction
  damage (a word split across a line break, a missing space) and nothing else.
- Never invent, infer, embellish, or "improve" anything. If the resume does not
  state a date, leave the field empty — do not guess from context.
- Split each role's description into individual bullets. One accomplishment per
  bullet. If the source is a paragraph, split it on sentence boundaries rather
  than merging it into a single bullet.
- Preserve numbers, metrics, and proper nouns exactly as written.
- Put skills into groups if the resume groups them; otherwise use one group
  named "Skills".
- Contact links go in \`basics.profiles\`, one entry each: LinkedIn, GitHub,
  a portfolio, an NPM or Stack Overflow page. Name the network as a person
  would say it ("LinkedIn", "GitHub"), and copy the address exactly as printed
  into \`url\`, even when it has no scheme. The one personal site or portfolio
  belongs in \`basics.url\` instead — do not list it in both places.
- A single date on an entry is its end date. Write it to \`endDate\` and leave
  \`startDate\` empty rather than repeating the same value in both.
- If a section is absent from the resume, return an empty array for it.

Extraction from PDFs is lossy. If a line looks garbled, transcribe your best
reading of it rather than dropping it — the user reviews and corrects every
field before anything is saved.`;

/** Model-facing shape: no IDs, since we mint those ourselves. */
const rawBulletSchema = z.object({ text: z.string() });

const rawSchema = z.object({
  basics: z
    .object({
      name: z.string().default(''),
      label: z.string().default(''),
      email: z.string().default(''),
      phone: z.string().default(''),
      url: z.string().default(''),
      summary: z.string().default(''),
      city: z.string().default(''),
      region: z.string().default(''),
      // LinkedIn, GitHub, and the like. A resume that lists them is telling the
      // reader where to go next, and dropping them silently loses the only part
      // of the document a human might actually click.
      profiles: z
        .array(
          z.object({
            network: z.string().default(''),
            username: z.string().default(''),
            url: z.string().default(''),
          }),
        )
        .default([]),
    })
    // `prefault` so a model response that omits `basics` still yields fully
    // populated string fields rather than `undefined`s.
    .prefault({}),
  work: z
    .array(
      z.object({
        name: z.string().default(''),
        position: z.string().default(''),
        location: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        summary: z.string().default(''),
        bullets: z.array(rawBulletSchema).default([]),
      }),
    )
    .default([]),
  education: z
    .array(
      z.object({
        institution: z.string().default(''),
        area: z.string().default(''),
        studyType: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        score: z.string().default(''),
        bullets: z.array(rawBulletSchema).default([]),
      }),
    )
    .default([]),
  projects: z
    .array(
      z.object({
        name: z.string().default(''),
        description: z.string().default(''),
        url: z.string().default(''),
        startDate: z.string().default(''),
        endDate: z.string().default(''),
        bullets: z.array(rawBulletSchema).default([]),
      }),
    )
    .default([]),
  skills: z
    .array(z.object({ name: z.string().default(''), keywords: z.array(z.string()).default([]) }))
    .default([]),
  certificates: z
    .array(
      z.object({
        name: z.string().default(''),
        issuer: z.string().default(''),
        date: z.string().default(''),
      }),
    )
    .default([]),
  awards: z
    .array(
      z.object({
        title: z.string().default(''),
        awarder: z.string().default(''),
        date: z.string().default(''),
        summary: z.string().default(''),
      }),
    )
    .default([]),
});

const strArray = { type: 'array', items: { type: 'string' } } as const;
const bulletArray = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
} as const;

function obj<T extends Record<string, unknown>>(properties: T) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  } as const;
}

const S = { type: 'string' } as const;

export const INGEST_JSON_SCHEMA = obj({
  basics: obj({
    name: S,
    label: S,
    email: S,
    phone: S,
    url: S,
    summary: S,
    city: S,
    region: S,
    profiles: { type: 'array', items: obj({ network: S, username: S, url: S }) },
  }),
  work: {
    type: 'array',
    items: obj({
      name: S,
      position: S,
      location: S,
      startDate: S,
      endDate: S,
      summary: S,
      bullets: bulletArray,
    }),
  },
  education: {
    type: 'array',
    items: obj({
      institution: S,
      area: S,
      studyType: S,
      startDate: S,
      endDate: S,
      score: S,
      bullets: bulletArray,
    }),
  },
  projects: {
    type: 'array',
    items: obj({ name: S, description: S, url: S, startDate: S, endDate: S, bullets: bulletArray }),
  },
  skills: { type: 'array', items: obj({ name: S, keywords: strArray }) },
  certificates: { type: 'array', items: obj({ name: S, issuer: S, date: S }) },
  awards: { type: 'array', items: obj({ title: S, awarder: S, date: S, summary: S }) },
});

/** Attaches stable IDs and normalises into a full Profile. */
export function rawToProfile(raw: z.infer<typeof rawSchema>, label: string): Profile {
  const now = new Date().toISOString();
  const withIds = (bullets: Array<{ text: string }>) =>
    bullets
      .filter((b) => b.text.trim())
      .map((b) => ({ id: ids.bullet(), text: b.text.trim(), tags: [], variants: [] }));

  return profileSchema.parse({
    id: ids.profile(),
    label,
    createdAt: now,
    updatedAt: now,
    basics: {
      name: raw.basics.name,
      label: raw.basics.label,
      email: raw.basics.email,
      phone: raw.basics.phone,
      url: raw.basics.url,
      summary: raw.basics.summary,
      location: { city: raw.basics.city, region: raw.basics.region },
      // A link with neither a username nor a URL names a network the reader
      // cannot visit, which is worse than omitting it.
      profiles: raw.basics.profiles
        .filter((p) => (p.username.trim() || p.url.trim()) && p.network.trim())
        .map((p) => ({
          network: p.network.trim(),
          username: p.username.trim(),
          url: p.url.trim(),
        })),
    },
    work: raw.work.map((w) => ({ id: ids.work(), ...w, bullets: withIds(w.bullets) })),
    education: raw.education.map((e) => ({
      id: ids.education(),
      ...e,
      courses: [],
      bullets: withIds(e.bullets),
    })),
    projects: raw.projects.map((p) => ({
      id: ids.project(),
      ...p,
      tags: [],
      bullets: withIds(p.bullets),
    })),
    skills: raw.skills.map((s) => ({ id: ids.skill(), ...s })),
    certificates: raw.certificates.map((c) => ({ id: ids.cert(), ...c })),
    awards: raw.awards.map((a) => ({ id: ids.award(), ...a })),
    languages: [],
  });
}

export interface IngestResult {
  profile: Profile;
  /** Fields the model left blank that usually should not be. Surfaced in the
   * confirmation form so the user knows where to look. */
  warnings: string[];
}

export async function ingestResume(
  text: string,
  provider: LLMProvider,
  cfg: ProviderConfig,
  opts: { label?: string; signal?: AbortSignal; onToken?: (s: string) => void } = {},
): Promise<IngestResult> {
  const result = await provider.complete(
    {
      system: INGEST_SYSTEM_PROMPT,
      user: `Convert this resume into the JSON structure.\n\n---\n${text}\n---`,
      jsonSchema: { name: 'resume_profile', schema: INGEST_JSON_SCHEMA },
      maxTokens: 16000,
      signal: opts.signal,
      onToken: opts.onToken,
    },
    cfg,
  );

  const parsed = rawSchema.safeParse(result.json);
  if (!parsed.success) {
    throw new Error(
      `The model returned a structure we could not read (${parsed.error.issues[0]?.message ?? 'unknown'}). Try again, or paste the text manually.`,
    );
  }

  const profile = rawToProfile(parsed.data, opts.label ?? 'Imported resume');

  const warnings: string[] = [];
  if (!profile.basics.name) warnings.push('No name was found.');
  if (!profile.basics.email) warnings.push('No email address was found.');
  if (profile.work.length === 0) warnings.push('No work experience was found.');
  const bulletCount = profile.work.reduce((n, w) => n + w.bullets.length, 0);
  if (profile.work.length > 0 && bulletCount === 0) {
    warnings.push('Roles were found but no bullets were extracted under them.');
  }
  for (const w of profile.work) {
    if (!w.startDate && !w.endDate) warnings.push(`No dates found for "${w.position || w.name}".`);
  }

  return { profile, warnings };
}
