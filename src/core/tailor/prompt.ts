import type { Profile } from '@/core/schema';
import type { JobDescription } from '@/core/jd/normalize';

export interface TailorConstraints {
  pageTarget: 1 | 2;
  tone: 'plain' | 'impact' | 'technical';
  seniority: string;
}

export const DEFAULT_CONSTRAINTS: TailorConstraints = {
  pageTarget: 1,
  tone: 'plain',
  seniority: '',
};

/**
 * The system prompt is the first of three layers of anti-fabrication defence.
 * It is not the load-bearing one — the token-level guard in `guard.ts` is, and
 * the provenance requirement in the plan schema is — but stating the rule
 * plainly measurably reduces how often the guard has to fire.
 */
export const TAILOR_SYSTEM_PROMPT = `You tailor an existing resume to a specific job posting.

You are given a MASTER PROFILE: a complete, structured record of everything the
candidate has actually done. Every bullet has a stable id. Some bullets have
stored variants, which are alternate phrasings of the same underlying fact.

Your job is selection and emphasis, not authorship.

WHAT YOU MAY DO
- Choose which entries and which bullets to include, and in what order.
- Reorder sections.
- Rephrase a bullet to foreground the aspect the posting cares about.
- Reuse a stored variant verbatim when one already fits.
- Rewrite the professional summary.
- Choose which existing skill keywords to show, and in what order.

WHAT YOU MUST NEVER DO
- Introduce a skill, technology, tool, employer, job title, date, credential,
  or metric that does not appear in the master profile. Not once, not softened,
  not implied.
- Change a number. If the profile says 40%, you may write "40%" or "40 percent",
  but never "over 40%", never "nearly 50%", never "significant".
- Change what a bullet claims. Rephrasing must preserve the underlying fact,
  including its scope and who did it.
- Assert seniority, scale, or ownership the profile does not support.
- Copy terminology from the job posting into the resume unless that exact term
  already appears in the master profile.

That last rule is the one most often broken. The posting is context for
selection only. If the posting asks for Kubernetes and the profile never
mentions Kubernetes, the correct output does not mention Kubernetes anywhere —
you record it in "notes" as an unmet requirement instead.

Every output element must carry the id of the profile element it derives from.
If you cannot point at a source id, the content does not belong in the output.

OUTPUT
Return only the JSON object described by the schema. Set include:false rather
than omitting entries, so the user can see what you chose to drop and why.
Give a one-sentence rationale for each decision — the user reviews every change
individually and rejects the ones they disagree with.`;

/** Compact profile projection sent to the model. IDs are load-bearing. */
function profileForModel(profile: Profile) {
  return {
    basics: {
      name: profile.basics.name,
      label: profile.basics.label,
      summary: profile.basics.summary,
    },
    work: profile.work.map((w) => ({
      id: w.id,
      company: w.name,
      position: w.position,
      location: w.location,
      startDate: w.startDate,
      endDate: w.endDate,
      summary: w.summary,
      bullets: w.bullets.map((b) => ({
        id: b.id,
        text: b.text,
        tags: b.tags,
        variants: b.variants.map((v) => ({ id: v.id, text: v.text })),
      })),
    })),
    projects: profile.projects.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      startDate: p.startDate,
      endDate: p.endDate,
      bullets: p.bullets.map((b) => ({
        id: b.id,
        text: b.text,
        tags: b.tags,
        variants: b.variants.map((v) => ({ id: v.id, text: v.text })),
      })),
    })),
    education: profile.education.map((e) => ({
      id: e.id,
      institution: e.institution,
      area: e.area,
      studyType: e.studyType,
      startDate: e.startDate,
      endDate: e.endDate,
      bullets: e.bullets.map((b) => ({ id: b.id, text: b.text, variants: b.variants.map((v) => ({ id: v.id, text: v.text })) })),
    })),
    skills: profile.skills.map((s) => ({ id: s.id, name: s.name, keywords: s.keywords })),
    certificates: profile.certificates.map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, date: c.date })),
    awards: profile.awards.map((a) => ({ id: a.id, title: a.title, awarder: a.awarder, date: a.date })),
  };
}

/** Rough guidance so the model prunes rather than overflowing the page. */
function budgetHint(profile: Profile, pageTarget: 1 | 2): string {
  const totalBullets = profile.work.reduce((n, w) => n + w.bullets.length, 0);
  const budget = pageTarget === 1 ? 14 : 26;
  return totalBullets > budget
    ? `The profile has ${totalBullets} experience bullets and the target is ${pageTarget} page(s), which fits roughly ${budget}. You will need to drop bullets. Drop the ones least relevant to this posting, and say why in each rationale.`
    : `The profile has ${totalBullets} experience bullets, which fits within ${pageTarget} page(s). Include what is relevant; you do not need to cut aggressively.`;
}

export function buildTailorUserPrompt(
  profile: Profile,
  jd: JobDescription,
  constraints: TailorConstraints,
): string {
  const toneLine = {
    plain: 'Plain and direct. No superlatives, no filler adjectives.',
    impact: 'Lead each bullet with the outcome, then the action that produced it.',
    technical: 'Foreground specific systems, tools, and technical decisions.',
  }[constraints.tone];

  return `# JOB POSTING
${jd.title ? `Title: ${jd.title}\n` : ''}${jd.company ? `Company: ${jd.company}\n` : ''}${jd.location ? `Location: ${jd.location}\n` : ''}
${jd.text}

# MASTER PROFILE
${JSON.stringify(profileForModel(profile), null, 1)}

# CONSTRAINTS
- Target length: ${constraints.pageTarget} page(s). ${budgetHint(profile, constraints.pageTarget)}
- Tone: ${toneLine}
${constraints.seniority ? `- Target seniority: ${constraints.seniority}. Do not claim seniority the profile does not support; adjust emphasis only.\n` : ''}
# TASK
Produce the tailoring plan. Remember: every proper noun, every technology, and
every number in your output must already appear in the master profile above.
Requirements from the posting that the profile cannot support go in "notes".`;
}
