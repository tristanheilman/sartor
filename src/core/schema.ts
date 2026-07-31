import { z } from 'zod';

/**
 * The master profile schema.
 *
 * This extends the JSON Resume schema (https://jsonresume.org/schema/) with the
 * three things tailoring requires:
 *
 *   1. Every bullet has a stable `id`, so a tailored document can point back at
 *      the exact fact it derives from. This is what powers both the diff view
 *      and the fabrication check.
 *   2. Every bullet carries `tags`, so selection can be steered by topic.
 *   3. Every bullet carries `variants` — alternate phrasings of the *same
 *      underlying fact*. Variants accumulate across tailoring runs, so the
 *      profile gets richer the more it is used.
 *
 * The master profile is append-only and lossless. It holds everything the user
 * has ever done. Tailoring is a selection-and-emphasis operation over that
 * superset; it never edits the master profile except to append variants.
 */

const nonEmpty = z.string().trim().min(1);

/** ISO-ish date. We accept `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or free text like
 * "Present" — real resumes are not consistent and refusing them loses data. */
export const dateStringSchema = z.string().trim().max(40);

export const variantSourceSchema = z.enum(['original', 'llm', 'user']);
export type VariantSource = z.infer<typeof variantSourceSchema>;

export const variantSchema = z.object({
  id: nonEmpty,
  text: nonEmpty,
  source: variantSourceSchema,
  createdAt: z.string(),
  /** Free-text note about where this phrasing came from, e.g. a job title. */
  note: z.string().optional(),
});
export type Variant = z.infer<typeof variantSchema>;

export const bulletSchema = z.object({
  id: nonEmpty,
  /** The canonical phrasing. Variants are alternates of *this* fact. */
  text: nonEmpty,
  tags: z.array(z.string().trim()).default([]),
  variants: z.array(variantSchema).default([]),
});
export type Bullet = z.infer<typeof bulletSchema>;

export const locationSchema = z.object({
  address: z.string().optional(),
  postalCode: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  countryCode: z.string().optional(),
});

export const profileLinkSchema = z.object({
  network: z.string(),
  username: z.string().optional(),
  url: z.string().optional(),
});

export const basicsSchema = z.object({
  name: z.string().default(''),
  label: z.string().default(''),
  email: z.string().default(''),
  phone: z.string().default(''),
  url: z.string().default(''),
  /** The master summary. Tailoring rewrites this, constrained by the guard. */
  summary: z.string().default(''),
  // `prefault`, not `default`: a plain `.default({})` is substituted verbatim
  // without being run through the inner schema, which would leave every field
  // `undefined` at runtime for any profile that omits this object.
  location: locationSchema.prefault({}),
  profiles: z.array(profileLinkSchema).default([]),
});
export type Basics = z.infer<typeof basicsSchema>;

export const workSchema = z.object({
  id: nonEmpty,
  name: z.string().default(''),
  position: z.string().default(''),
  url: z.string().optional(),
  location: z.string().optional(),
  startDate: dateStringSchema.default(''),
  endDate: dateStringSchema.default(''),
  summary: z.string().default(''),
  bullets: z.array(bulletSchema).default([]),
  tags: z.array(z.string()).default([]),
});
export type Work = z.infer<typeof workSchema>;

export const educationSchema = z.object({
  id: nonEmpty,
  institution: z.string().default(''),
  area: z.string().default(''),
  studyType: z.string().default(''),
  startDate: dateStringSchema.default(''),
  endDate: dateStringSchema.default(''),
  score: z.string().optional(),
  courses: z.array(z.string()).default([]),
  bullets: z.array(bulletSchema).default([]),
});
export type Education = z.infer<typeof educationSchema>;

export const projectSchema = z.object({
  id: nonEmpty,
  name: z.string().default(''),
  description: z.string().default(''),
  url: z.string().optional(),
  startDate: dateStringSchema.default(''),
  endDate: dateStringSchema.default(''),
  bullets: z.array(bulletSchema).default([]),
  tags: z.array(z.string()).default([]),
});
export type Project = z.infer<typeof projectSchema>;

export const skillGroupSchema = z.object({
  id: nonEmpty,
  name: z.string().default(''),
  keywords: z.array(z.string()).default([]),
});
export type SkillGroup = z.infer<typeof skillGroupSchema>;

export const certificateSchema = z.object({
  id: nonEmpty,
  name: z.string().default(''),
  issuer: z.string().default(''),
  date: dateStringSchema.default(''),
  url: z.string().optional(),
});
export type Certificate = z.infer<typeof certificateSchema>;

export const awardSchema = z.object({
  id: nonEmpty,
  title: z.string().default(''),
  awarder: z.string().default(''),
  date: dateStringSchema.default(''),
  summary: z.string().default(''),
});
export type Award = z.infer<typeof awardSchema>;

export const languageSchema = z.object({
  id: nonEmpty,
  language: z.string().default(''),
  fluency: z.string().default(''),
});

export const profileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: nonEmpty,
  label: z.string().default('My profile'),
  createdAt: z.string(),
  updatedAt: z.string(),
  basics: basicsSchema.prefault({}),
  work: z.array(workSchema).default([]),
  education: z.array(educationSchema).default([]),
  projects: z.array(projectSchema).default([]),
  skills: z.array(skillGroupSchema).default([]),
  certificates: z.array(certificateSchema).default([]),
  awards: z.array(awardSchema).default([]),
  languages: z.array(languageSchema).default([]),
});
export type Profile = z.infer<typeof profileSchema>;

/** Section keys that a tailored resume may reorder. */
export const SECTION_KEYS = [
  'summary',
  'skills',
  'work',
  'projects',
  'education',
  'certificates',
  'awards',
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * Parses unknown data into a Profile, applying defaults. Throws on structural
 * failure — callers ingesting model output should use `safeParseProfile`.
 */
export function parseProfile(data: unknown): Profile {
  return profileSchema.parse(data);
}

export function safeParseProfile(data: unknown) {
  return profileSchema.safeParse(data);
}

/** Every bullet in the profile, with the section it belongs to. */
export function allBullets(
  profile: Profile,
): Array<{ bullet: Bullet; ownerId: string; ownerLabel: string; section: SectionKey }> {
  const out: Array<{ bullet: Bullet; ownerId: string; ownerLabel: string; section: SectionKey }> = [];
  for (const w of profile.work) {
    for (const b of w.bullets) {
      out.push({ bullet: b, ownerId: w.id, ownerLabel: `${w.position} · ${w.name}`, section: 'work' });
    }
  }
  for (const p of profile.projects) {
    for (const b of p.bullets) {
      out.push({ bullet: b, ownerId: p.id, ownerLabel: p.name, section: 'projects' });
    }
  }
  for (const e of profile.education) {
    for (const b of e.bullets) {
      out.push({ bullet: b, ownerId: e.id, ownerLabel: e.institution, section: 'education' });
    }
  }
  return out;
}

export function findBullet(profile: Profile, bulletId: string): Bullet | undefined {
  return allBullets(profile).find((x) => x.bullet.id === bulletId)?.bullet;
}

export function emptyProfile(id: string, now = new Date().toISOString()): Profile {
  return profileSchema.parse({ id, createdAt: now, updatedAt: now });
}
