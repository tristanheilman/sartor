import { z } from 'zod';
import { profileSchema, type Profile } from '../core/schema';
import { tailorPlanSchema } from '../core/tailor/plan';
import type { TailorRun } from '../core/tailor/apply';
import { CliError, EXIT, describeIssues, readJson, writeOut, type Io } from './io';

/**
 * Everything one tailoring run produced, in one file.
 *
 * The profile is embedded rather than referenced. Rendering, reviewing and
 * checking a run all need the exact profile the plan was made against — a
 * plan's bullet ids mean nothing against a profile edited since — and a file
 * that carries its own source cannot be paired with the wrong one.
 *
 * Versioned by `format`, so a later CLI can read an earlier run or say plainly
 * that it cannot.
 */
export const RUN_FORMAT = 'sartor.run/1';

const changeSchema = z.object({
  id: z.string(),
  kind: z.string(),
  section: z.string(),
  label: z.string(),
  sourceId: z.string(),
  before: z.string(),
  after: z.string(),
  rationale: z.string(),
  status: z.enum(['accepted', 'rejected']),
  reviewed: z.boolean(),
  violations: z.array(z.object({ id: z.string() }).passthrough()),
  acknowledged: z.array(z.string()),
});

export const runFileSchema = z.object({
  format: z.literal(RUN_FORMAT),
  /** The template the page was fitted to. Rendering in another may not fit. */
  template: z.string(),
  profile: profileSchema,
  run: z
    .object({
      id: z.string(),
      profileId: z.string(),
      createdAt: z.string(),
      providerId: z.string(),
      model: z.string(),
      jd: z.object({ text: z.string() }).passthrough(),
      constraints: z.object({ pageTarget: z.union([z.literal(1), z.literal(2)]) }).passthrough(),
      plan: tailorPlanSchema,
      changes: z.array(changeSchema),
      notes: z.string(),
    })
    .passthrough(),
  /** What the model chose, before the fit pass. Kept so a run can be audited. */
  modelPlan: tailorPlanSchema.optional(),
  fit: z
    .object({
      dropped: z.array(z.string()),
      added: z.array(z.string()),
      restoredSkills: z.array(z.string()),
      droppedEntries: z.array(z.string()),
      fits: z.boolean(),
      reinstated: z.string().nullable(),
    })
    .optional(),
});

export interface RunFile {
  format: typeof RUN_FORMAT;
  template: string;
  profile: Profile;
  run: TailorRun;
  modelPlan?: z.infer<typeof tailorPlanSchema>;
  fit?: z.infer<typeof runFileSchema>['fit'];
}

export async function readRunFile(io: Io, path: string): Promise<RunFile> {
  const json = await readJson(io, path, 'the run file');
  const format = (json as { format?: unknown })?.format;
  if (format !== RUN_FORMAT) {
    throw new CliError(
      'not_a_run_file',
      `${path} is not a Sartor run file (format ${JSON.stringify(format)}, expected "${RUN_FORMAT}").`,
      'Pass the file written by `sartor tailor apply` or `sartor tailor run`.',
    );
  }
  const parsed = runFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError('invalid_run_file', `${path} does not match the run file format: ${describeIssues(parsed.error.issues)}.`, 'Re-create it with `sartor tailor apply`; run files are not meant to be edited by hand.', EXIT.input);
  }
  return parsed.data as unknown as RunFile;
}

export async function writeRunFile(io: Io, path: string, file: RunFile): Promise<string> {
  return writeOut(io, path, `${JSON.stringify(file, null, 2)}\n`);
}
