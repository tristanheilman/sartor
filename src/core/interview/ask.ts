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

You are transcribing, not writing.

ASKING
- Ask about one specific thing. "What did the Kotlin bridge module do?" — not
  "tell me about your Android experience".
- Assume they are busy. One question, answerable in two sentences out loud.
- Never ask for something the profile already says. You are filling gaps.
- Never ask a question whose obvious answer is a number they will feel pressure
  to guess at. Ask what they did; if a number comes up naturally, keep it.

WRITING THE BULLET
- Use only facts the answer states. Not the question, not the posting, not what
  would sound good.
- If they gave no metric, write the bullet with no metric. A bullet without a
  number is worth more than one with an invented number.
- Keep their words where you can. Fix grammar, not substance.
- Do not upgrade scope. "helped with" does not become "led". "a few" does not
  become "several thousand".
- If the answer does not describe something that belongs on a resume, return no
  bullets at all. That is a valid and common outcome.

CONFIDENCE
Mark a bullet "uncertain" when the answer was vague and you had to choose an
interpretation. The user sees that flag and checks it first.`;

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

export const draftedBulletsSchema = z.object({
  bullets: z.array(draftedBulletSchema).default([]),
  newRole: draftedRoleSchema.prefault({}),
  endedRole: endedRoleSchema.prefault({}),
});
export type DraftedBullet = z.infer<typeof draftedBulletSchema>;

const S = { type: 'string' } as const;

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
  required: ['bullets', 'newRole', 'endedRole'],
  properties: {
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

  return `Question asked: ${question}

Their answer, verbatim:
"""
${answer}
"""

This was about: ${gap.subject}

Attach each bullet to the role the work happened at, using its ownerId:

${JSON.stringify(roles, null, 2)}

${
  gap.ownerId
    ? `This question was asked about ownerId "${gap.ownerId}"; use that unless the answer clearly names a different role.`
    : 'Pick the role the answer names. If the answer names no role and you cannot tell, use the most recent one.'
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

Write the resume bullet or bullets this answer supports. Use only what the answer says.`;
}
