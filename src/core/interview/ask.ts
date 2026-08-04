import { z } from 'zod';
import type { Profile } from '../schema';
import type { Gap } from './gaps';

/**
 * Turning a measured gap into a question, and an answer into bullets.
 *
 * This is the one place in the system where genuinely new facts enter. The
 * fabrication guard cannot help here: it checks that tailored output is a
 * subset of the profile, so anything invented at this step becomes permanently
 * "grounded" and is faithfully carried into every resume thereafter.
 *
 * The only defence is that the model transcribes rather than writes, and that
 * the user confirms every bullet. Both are load-bearing.
 */

export const INTERVIEW_SYSTEM_PROMPT = `You are interviewing someone about work they have already done, so it can be recorded accurately on their resume.

Write the resume line they would have written if they had time. Say only what
they said.

ASKING
- Ask about one specific thing. "What did the Kotlin bridge module do?" — not
  "tell me about your Android experience".
- Assume they are busy. One question, answerable in two sentences out loud.
- Never ask for something the profile already says. You are filling gaps.
- Never ask a question whose obvious answer is a number they will feel pressure
  to guess at. Ask what they did; if a number comes up naturally, keep it.

WRITING THE BULLET
You may rewrite freely for strength. Lead with what they did, use the active
voice, cut the hedge and the throat-clearing. "I was kind of the person who
ended up owning the release process" is a good bullet trying to get out.

What you may never do is add a fact:
- Every proper noun, product, tool, employer and number must come from the
  answer or from the profile. This is checked afterwards, and a bullet that
  introduces something unsupported is thrown away.
- If they gave no metric, write it with no metric. A bullet without a number is
  worth more than one with a number nobody can defend.
- Never upgrade scope. "helped with" is not "led". "a few" is not "several
  thousand". "we" is not "I".
- Never turn a task into an achievement. "Used JIRA daily" is not worth a line
  on a resume and dressing it up does not make it one — return no bullets
  instead. That is a valid and common outcome.

ASKING AGAIN
If the answer is too vague to write down, or you had to guess at what they
meant, put one short follow-up question in "followUp" and return no bullets for
it. One question, about the specific thing that was missing — "what was running
in the containers?" rather than "can you tell me more?". Leave it empty when
the answer was clear.

CONFIDENCE
Mark a bullet "uncertain" when you had to choose between readings of what they
said. That flag is read: it decides whether they get asked again.`;

export const questionSchema = z.object({
  gapId: z.string(),
  question: z.string(),
  /** Shown under the question so it reads as purposeful rather than nosy. */
  why: z.string().default(''),
});

export const questionsSchema = z.object({ questions: z.array(questionSchema).default([]) });
export type InterviewQuestion = z.infer<typeof questionSchema>;

export const draftedBulletSchema = z.object({
  text: z.string(),
  /** Profile entry this belongs under, echoed from the gap. */
  ownerId: z.string().default(''),
  uncertain: z.boolean().default(false),
  /** What in the answer supports this. The audit trail for a generated fact. */
  basis: z.string().default(''),
});

/**
 * A job the profile does not have yet.
 *
 * `merge.ts` has always been able to add a work entry — it mints fresh IDs and
 * two tests cover it — but nothing upstream could ever *produce* one. Without
 * this, an answer describing a new job got its bullets filed under whichever
 * old role the model guessed at, which is worse than refusing outright.
 *
 * An empty `name` means "the answer did not describe a new job", which is the
 * common case and must stay cheap.
 */
export const draftedRoleSchema = z.object({
  name: z.string().default(''),
  position: z.string().default(''),
  location: z.string().default(''),
  startDate: z.string().default(''),
  endDate: z.string().default(''),
});
export type DraftedRole = z.infer<typeof draftedRoleSchema>;

/**
 * A role the answer says has ended.
 *
 * "I left Northwind back in November" is a fact the interview hears and, until
 * this existed, threw away — leaving the old role open-ended while adding the
 * new one, so the resume claimed two concurrent jobs. `merge.ts` surfaces the
 * correction; this is what tells it there is one.
 */
export const endedRoleSchema = z.object({
  ownerId: z.string().default(''),
  endDate: z.string().default(''),
});

/**
 * A project the answer describes.
 *
 * Separate from bullets because a project is an entry, not a line under an
 * existing one. Without this, an answer about side projects had nowhere to go
 * and its bullets fell through to whichever employer owned the fallback — so
 * personal work published on someone's own time was filed under their current
 * job, which is a factual error a reader would hold against them.
 */
export const draftedProjectSchema = z.object({
  name: z.string().default(''),
  url: z.string().default(''),
  bullets: z.array(z.string()).default([]),
});
export type DraftedProject = z.infer<typeof draftedProjectSchema>;

export const draftedBulletsSchema = z.object({
  /** Projects the answer describes. Empty unless it was about projects. */
  newProjects: z.array(draftedProjectSchema).default([]),
  bullets: z.array(draftedBulletSchema).default([]),
  newRole: draftedRoleSchema.prefault({}),
  endedRole: endedRoleSchema.prefault({}),
  /**
   * The professional summary, when that is what was asked about.
   *
   * Not every answer belongs to a job. With nowhere for this to go, an answer
   * describing a whole career was written as bullets and attached to whichever
   * role was most recent — so "Enjoys owning a feature end to end" appeared
   * under one employer, as though it were something that happened there.
   */
  summary: z.string().default(''),
  /**
   * One more question, when the answer was too vague to write down.
   *
   * Empty means the answer was enough. Callers allow one of these per question:
   * being asked twice is irritating in a way being asked once is not.
   */
  followUp: z.string().default(''),
});
export type DraftedBullet = z.infer<typeof draftedBulletSchema>;

const S = { type: 'string' } as const;

/** Fences the answer so the model cannot mistake it for instructions. */
const quote = (text: string) => `"""\n${text}\n"""`;

export const QUESTIONS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gapId', 'question', 'why'],
        properties: { gapId: S, question: S, why: S },
      },
    },
  },
} as const;

export const DRAFTED_BULLETS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bullets', 'newProjects', 'newRole', 'endedRole', 'summary', 'followUp'],
  properties: {
    summary: S,
    followUp: S,
    newProjects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'url', 'bullets'],
        properties: { name: S, url: S, bullets: { type: 'array', items: S } },
      },
    },
    endedRole: {
      type: 'object',
      additionalProperties: false,
      required: ['ownerId', 'endDate'],
      properties: { ownerId: S, endDate: S },
    },
    newRole: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'position', 'location', 'startDate', 'endDate'],
      properties: { name: S, position: S, location: S, startDate: S, endDate: S },
    },
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'ownerId', 'uncertain', 'basis'],
        properties: { text: S, ownerId: S, uncertain: { type: 'boolean' }, basis: S },
      },
    },
  },
} as const;

/** Context the model needs to ask a good question, and nothing more. */
function profileSketch(profile: Profile) {
  return {
    label: profile.basics.label,
    roles: profile.work.map((w) => ({
      id: w.id,
      title: `${w.position} at ${w.name}`,
      dates: `${w.startDate}–${w.endDate || 'present'}`,
      bullets: w.bullets.map((b) => b.text),
    })),
    skills: profile.skills.map((s) => `${s.name}: ${s.keywords.join(', ')}`),
  };
}

export function buildQuestionsPrompt(profile: Profile, gaps: Gap[]): string {
  return `Here is what we already know about this person:

${JSON.stringify(profileSketch(profile), null, 2)}

Here are the gaps, already ranked. Write one question for each, in this order.

${JSON.stringify(
  gaps.map((g) => ({ gapId: g.id, about: g.subject, whyItMatters: g.why, attachesTo: g.ownerLabel })),
  null,
  2,
)}

Return one question per gap, keeping the gapId exactly as given.`;
}

/**
 * Turns one answer into bullets.
 *
 * The roles are listed because a bullet with no `ownerId` belongs to no entry
 * and is silently dropped by the merge — which is exactly what happened the
 * first time this ran. Most gaps worth asking about (an unevidenced skill, say)
 * are not tied to a role in advance; the *answer* is what reveals where the
 * work happened. So the model is given the list and asked to place it, which is
 * what a person doing this by hand would do.
 */
export function buildAnswerPrompt(
  gap: Gap,
  question: string,
  answer: string,
  profile: Profile,
): string {
  const roles = profile.work.map((w) => ({
    ownerId: w.id,
    role: `${w.position} at ${w.name}`,
    dates: `${w.startDate}–${w.endDate || 'present'}`,
  }));

  // A question about projects is not a question about a job, so it is not
  // given a prompt about jobs. Adding a clause to the role-attaching prompt
  // was not enough: that prompt opens by listing employers and closes by
  // asking for bullets, so the conditional in the middle lost — and the
  // content was dropped rather than written up.
  if (gap.kind === 'more-projects' || gap.kind === 'thin-project') {
    const known = profile.projects.map((p) => ({ id: p.id, name: p.name }));

    return `Question asked: ${question}

Their answer, verbatim:
${quote(answer)}

Put every project the answer describes into "newProjects": its name, its URL if
they gave one, and its own bullets. One entry per project — an answer listing
four packages is four entries, not four lines under one heading.

Already on file, so do not repeat them:

${JSON.stringify(known, null, 2)}

${
  gap.kind === 'thin-project'
    ? `This question was about ${gap.subject}. Put what they said about it under that name so it merges with the entry already there.`
    : 'If the answer only elaborates on a project already listed above, use that same name so it merges rather than duplicating.'
}

Return no ordinary bullets and leave "newRole", "endedRole" and "summary"
empty. A side project is not work done at an employer, and filing it under one
says something untrue about who it was for.`;
  }

  // A summary describes a career, not something that happened at one employer.
  // Asking for bullets here and then placing them is how an answer about the
  // whole of someone's work ended up filed under their current job.
  if (gap.kind === 'no-summary') {
    return `Question asked: ${question}

Their answer, verbatim:
${quote(answer)}

Write this as their professional summary: two or three sentences, in their own
words, stating only what the answer states. Put it in "summary".

Return no bullets. This describes their career as a whole, not work done at any
one employer, so none of it belongs under a job.`;
  }

  return `Question asked: ${question}

Their answer, verbatim:
${quote(answer)}

This was about: ${gap.subject}

Attach each bullet to the role the work happened at, using its ownerId:

${JSON.stringify(roles, null, 2)}

${
  gap.ownerId
    ? `This question was asked about ownerId "${gap.ownerId}"; use that unless the answer clearly names a different role.`
    : 'Use the role the answer names. If it names none, leave ownerId empty — do not guess from recency. Something that spans several jobs belongs to whichever one the answer is actually about, and an empty ownerId is resolved from what the profile already says.'
}

IF THE ANSWER DESCRIBES A JOB THAT IS NOT IN THAT LIST
Fill in "newRole" with the employer, title, location and dates the answer gives,
and set ownerId to "new" on every bullet that belongs to it. Leave any field the
answer does not state empty — an invented start date is a lie about a fact that
is trivially checked.

Otherwise leave every field of "newRole" empty.

IF THE ANSWER SAYS THEY LEFT A ROLE THAT IS IN THE LIST
Fill in "endedRole" with that role's ownerId and the month they left, in the
same format the other dates use. Only when they say so — a role you assume has
ended because a newer one started is a guess, and dates are checked.

Otherwise leave both fields of "endedRole" empty.

Leave "summary" empty; this question was not about their profile as a whole.

Write the resume bullet or bullets this answer supports. Use only what the answer says.`;
}
