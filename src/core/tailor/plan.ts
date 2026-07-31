import { z } from 'zod';
import { SECTION_KEYS } from '../schema';

/**
 * The tailoring plan is the *only* thing the model produces. It is a selection
 * over the master profile, never a document.
 *
 * Every element carries the ID of the source it derives from. That constraint
 * is what makes both the diff view and the fabrication check possible: if the
 * model cannot point at a source ID, the content has no provenance and is
 * rejected before it ever reaches a renderer.
 */

export const plannedBulletSchema = z.object({
  /** Must match a bullet ID from the master profile. */
  bulletId: z.string(),
  include: z.boolean(),
  order: z.number().int().min(0),
  /**
   * The phrasing to use. Either an existing variant reproduced verbatim, or a
   * new rephrasing of the same fact. Empty means "use the canonical text".
   */
  text: z.string().default(''),
  /** `existing` if `text` reproduces a stored variant, `new` if rephrased. */
  textSource: z.enum(['canonical', 'existing', 'new']).default('canonical'),
  /** Set when textSource is `existing`. */
  variantId: z.string().optional(),
  /** One short sentence: why this bullet was kept, dropped, or rephrased. */
  rationale: z.string().default(''),
});
export type PlannedBullet = z.infer<typeof plannedBulletSchema>;

export const plannedEntrySchema = z.object({
  /** Must match a work / project / education ID from the master profile. */
  id: z.string(),
  include: z.boolean(),
  order: z.number().int().min(0),
  bullets: z.array(plannedBulletSchema).default([]),
});
export type PlannedEntry = z.infer<typeof plannedEntrySchema>;

export const plannedSkillGroupSchema = z.object({
  /** Must match a skill group ID from the master profile. */
  id: z.string(),
  include: z.boolean(),
  order: z.number().int().min(0),
  /** A subset of the group's existing keywords, reordered. Never new ones. */
  keywords: z.array(z.string()).default([]),
});

export const tailorPlanSchema = z.object({
  summary: z.object({
    text: z.string().default(''),
    rationale: z.string().default(''),
  }),
  sectionOrder: z.array(z.enum(SECTION_KEYS)).default([...SECTION_KEYS]),
  work: z.array(plannedEntrySchema).default([]),
  projects: z.array(plannedEntrySchema).default([]),
  education: z.array(plannedEntrySchema).default([]),
  skills: z.array(plannedSkillGroupSchema).default([]),
  /** Model's own note on what it could not satisfy from the profile. */
  notes: z.string().default(''),
});
export type TailorPlan = z.infer<typeof tailorPlanSchema>;

/**
 * JSON Schema handed to the provider for constrained decoding. Kept hand-written
 * rather than generated so the provider-facing contract stays stable and
 * readable, and so it satisfies the strict-mode rules every provider imposes
 * (`additionalProperties: false`, all keys required).
 */
export const TAILOR_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'sectionOrder', 'work', 'projects', 'education', 'skills', 'notes'],
  properties: {
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'rationale'],
      properties: {
        text: { type: 'string', description: 'Rewritten professional summary.' },
        rationale: { type: 'string' },
      },
    },
    sectionOrder: {
      type: 'array',
      items: { type: 'string', enum: [...SECTION_KEYS] },
    },
    work: { $ref: '#/$defs/entries' },
    projects: { $ref: '#/$defs/entries' },
    education: { $ref: '#/$defs/entries' },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'include', 'order', 'keywords'],
        properties: {
          id: { type: 'string' },
          include: { type: 'boolean' },
          order: { type: 'integer' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Subset of the group existing keywords. Never invent one.',
          },
        },
      },
    },
    notes: {
      type: 'string',
      description:
        'Requirements from the posting that the profile does not support. State them plainly; do not paper over them.',
    },
  },
  $defs: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'include', 'order', 'bullets'],
        properties: {
          id: { type: 'string' },
          include: { type: 'boolean' },
          order: { type: 'integer' },
          bullets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['bulletId', 'include', 'order', 'text', 'textSource', 'variantId', 'rationale'],
              properties: {
                bulletId: { type: 'string' },
                include: { type: 'boolean' },
                order: { type: 'integer' },
                text: { type: 'string' },
                textSource: { type: 'string', enum: ['canonical', 'existing', 'new'] },
                variantId: { type: 'string' },
                rationale: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;
