import type { Profile } from '../schema';
import type { JobDescription } from '../jd/normalize';

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

KEEPING THE WORK HISTORY INTACT
A job is evidence that the candidate was employed, which is separate from
whether its bullets are worth reading. Dropping a role leaves a hole in the
dates, and a reader fills an unexplained hole with the worst explanation
available. That costs more than a weak bullet ever does.

So when a role's bullets are weak or off-topic for this posting, cut the
bullets, not the role. Set include:true on the entry and keep only its single
most relevant bullet — or none at all, leaving just the employer, title and
dates. Reserve include:false for a role the candidate would not want on any
resume at all.

When the page is tight, take bullets from the roles that have the most, and
from the oldest roles first. Never buy space by removing an employer.

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

/**
 * How many bullets are left once everything else on the page is paid for.
 *
 * This was a flat 14 for one page, which ignored the whole top of the
 * document. Measured on a real profile, fifteen kept bullets still came to two
 * pages: a nine-line summary, five skill groups, three role headings, project
 * headings and an education entry cost about thirty-five lines before a single
 * bullet is printed. The same flat number is far too generous for a full
 * profile and needlessly stingy for a sparse one.
 *
 * The arithmetic mirrors `estimateLines`, which is what the page-fit check
 * measures the result against — so the budget and the verdict are computed the
 * same way rather than drifting apart. Fifty lines is a page in the default
 * template; a denser one simply leaves room to spare.
 *
 * Entry counts come from the profile, which over-states the overhead, since
 * tailoring may drop entries. That errs toward fitting, which is the direction
 * to err in: a resume that comes in short is a smaller problem than one that
 * silently runs onto a second page.
 */
function bulletBudget(profile: Profile, pageTarget: 1 | 2): number {
  const LINES_PER_PAGE = 50;
  let overhead = 4; // name and contact block

  if (profile.basics.summary.trim()) {
    overhead += 2 + Math.ceil(profile.basics.summary.length / 105);
  }
  if (profile.skills.length) {
    overhead +=
      2 +
      profile.skills.reduce(
        (n, g) => n + Math.ceil((g.name.length + g.keywords.join(', ').length) / 100),
        0,
      );
  }
  // Two lines per entry: the title and employer line, and the dates and
  // location beside it.
  if (profile.work.length) overhead += 2 + profile.work.length * 2;
  if (profile.projects.length) overhead += 2 + profile.projects.length * 2;
  if (profile.education.length) overhead += 2 + profile.education.length * 2;

  // A bullet is one line more often than two, but long ones wrap.
  const AVERAGE_BULLET_LINES = 1.25;
  const available = LINES_PER_PAGE * pageTarget - overhead;

  // Even a crowded profile has to be allowed to say something; below this the
  // advice stops being a budget and becomes an instruction to delete the
  // resume.
  return Math.max(6, Math.floor(available / AVERAGE_BULLET_LINES));
}

/**
 * Rough guidance so the model prunes rather than overflowing the page.
 *
 * Counts projects as well as roles. It used to count `profile.work` alone,
 * which made the budget wrong for exactly the people this tool is for: someone
 * with six published projects was told their eight experience bullets "fit
 * within 1 page" while thirty project lines competed for the same space, and
 * the tailored resume came out at two pages against a one-page target.
 *
 * A project bullet occupies a line just like a role bullet does, and a project
 * entry costs a heading on top of that. Nothing about the page cares which
 * section a line came from.
 */
function budgetHint(profile: Profile, pageTarget: 1 | 2): string {
  const roleBullets = profile.work.reduce((n, w) => n + w.bullets.length, 0);
  const projectBullets = profile.projects.reduce((n, p) => n + p.bullets.length, 0);
  const totalBullets = roleBullets + projectBullets;
  const budget = bulletBudget(profile, pageTarget);

  const inventory =
    projectBullets > 0
      ? `${totalBullets} bullets across experience and projects (${roleBullets} in roles, ${projectBullets} in projects)`
      : `${totalBullets} experience bullets`;

  return totalBullets > budget
    ? `The profile has ${inventory} and the target is ${pageTarget} page(s), which fits roughly ${budget} in total. You will need to drop bullets — bullets, not whole roles. Drop the ones least relevant to this posting, taking them from the entries that have the most and from the oldest first. Project bullets count against the same budget as role bullets, so cut them on relevance too rather than protecting one section. Say why in each rationale.`
    : `The profile has ${inventory}, which fits within ${pageTarget} page(s) — roughly ${budget} fit alongside the summary, skills and headings. Include what is relevant; you do not need to cut aggressively.`;
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
