import type { Profile } from '../schema';
import { ids } from '../ids';
import type { LLMProvider, ProviderConfig } from '../provider';
import type { JobDescription } from '../jd/normalize';
import { tailorPlanSchema, TAILOR_PLAN_JSON_SCHEMA, type TailorPlan } from './plan';
import { TAILOR_SYSTEM_PROMPT, buildTailorUserPrompt, type TailorConstraints } from './prompt';
import { buildChanges, type TailorRun } from './apply';
import { fitToTarget } from './fit';
import type { PageMetrics } from '../render/model';

/**
 * Drops anything in the plan that does not point at a real profile element.
 *
 * This is the provenance rule made mechanical: an element with no valid source
 * ID has no traceable origin, so it is discarded before it can reach a change,
 * a document, or a renderer. A model that hallucinates a whole extra job cannot
 * get it onto the page even if the token-level guard misses the wording.
 */
export function validatePlan(
  plan: TailorPlan,
  profile: Profile,
): { plan: TailorPlan; dropped: string[] } {
  const dropped: string[] = [];

  const workIds = new Set(profile.work.map((w) => w.id));
  const projectIds = new Set(profile.projects.map((p) => p.id));
  const educationIds = new Set(profile.education.map((e) => e.id));
  const skillIds = new Set(profile.skills.map((s) => s.id));

  const bulletIdsFor = (entryId: string): Set<string> => {
    const source =
      profile.work.find((w) => w.id === entryId) ??
      profile.projects.find((p) => p.id === entryId) ??
      profile.education.find((e) => e.id === entryId);
    return new Set((source?.bullets ?? []).map((b) => b.id));
  };

  const filterEntries = (entries: TailorPlan['work'], valid: Set<string>, kind: string) =>
    entries
      .filter((e) => {
        if (valid.has(e.id)) return true;
        dropped.push(`${kind} entry "${e.id}" is not in your profile.`);
        return false;
      })
      .map((e) => {
        const ok = bulletIdsFor(e.id);
        return {
          ...e,
          bullets: e.bullets.filter((b) => {
            if (ok.has(b.bulletId)) return true;
            dropped.push(`Bullet "${b.bulletId}" is not in your profile.`);
            return false;
          }),
        };
      });

  return {
    plan: {
      ...plan,
      work: filterEntries(plan.work, workIds, 'Experience'),
      projects: filterEntries(plan.projects, projectIds, 'Project'),
      education: filterEntries(plan.education, educationIds, 'Education'),
      skills: plan.skills.filter((s) => {
        if (skillIds.has(s.id)) return true;
        dropped.push(`Skill group "${s.id}" is not in your profile.`);
        return false;
      }),
    },
    dropped,
  };
}

export interface RunOptions {
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  /**
   * The template the result will be rendered in, which decides how much text a
   * page holds. Omitted, the trim assumes the default density — which errs
   * toward cutting slightly more than a compact template needs.
   */
  template?: PageMetrics;
}

export interface TailorOutcome {
  run: TailorRun;
  /** Plan elements discarded for pointing at nothing real. Shown to the user. */
  dropped: string[];
  /**
   * Bullets switched off to reach the page target, and whether it worked.
   * `false` means the document is as small as the trim is willing to make it —
   * roles and their first bullet are never taken.
   */
  fit: {
    dropped: string[];
    added: string[];
    restoredSkills: string[];
    droppedEntries: string[];
    fits: boolean;
    /** A project the posting asked for that the model had dropped, put back. */
    reinstated: string | null;
  };
}

/** One call in, one reviewable run out. */
export async function runTailor(
  profile: Profile,
  jd: JobDescription,
  constraints: TailorConstraints,
  provider: LLMProvider,
  cfg: ProviderConfig,
  opts: RunOptions = {},
): Promise<TailorOutcome> {
  const result = await provider.complete(
    {
      system: TAILOR_SYSTEM_PROMPT,
      user: buildTailorUserPrompt(profile, jd, constraints),
      jsonSchema: { name: 'tailor_plan', schema: TAILOR_PLAN_JSON_SCHEMA },
      maxTokens: 16000,
      signal: opts.signal,
      onToken: opts.onToken,
    },
    cfg,
  );

  const parsed = tailorPlanSchema.safeParse(result.json);
  if (!parsed.success) {
    throw new Error(
      `The model returned a plan we could not read (${parsed.error.issues[0]?.message ?? 'unknown'}). Try again.`,
    );
  }

  const { plan, dropped } = validatePlan(parsed.data, profile);

  // Length is arithmetic, and the model has never reliably done it. Asking for
  // "roughly 6 bullets" produced twenty-five; the same prompt across three runs
  // gave two, two and three pages against a one-page target. So the plan is
  // trimmed to fit rather than trusted to. Nothing is rewritten — bullets are
  // switched off, which the review screen already shows as changes the user can
  // put back one at a time.
  const fitted = fitToTarget(profile, plan, constraints.pageTarget, opts.template, jd.text);

  return {
    run: {
      id: ids.run(),
      profileId: profile.id,
      createdAt: new Date().toISOString(),
      providerId: provider.info.id,
      model: result.model || cfg.model,
      jd,
      constraints,
      plan: fitted.plan,
      changes: buildChanges(profile, fitted.plan),
      notes: plan.notes,
    },
    dropped,
    fit: {
      dropped: fitted.dropped,
      added: fitted.added,
      restoredSkills: fitted.restoredSkills,
      droppedEntries: fitted.droppedEntries,
      fits: fitted.fits,
      reinstated: fitted.reinstated,
    },
  };
}
