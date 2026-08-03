import type { Profile } from '../schema';
import { buildLexicon } from '../tailor/lexicon';
import { checkText, type Violation } from '../tailor/guard';
import type { DraftedBullet } from './ask';

/**
 * Checking a drafted bullet against what the person actually said.
 *
 * The interview prompt used to forbid rewriting outright — "transcribing, not
 * writing" — which kept fabrication out but also meant a weak answer became a
 * weak bullet. "I use JIRA daily" came back as "Used JIRA daily to track
 * assigned tasks", which is filler nobody would keep.
 *
 * That rule was doing two jobs at once, and only one of them was load-bearing:
 *
 *   - **Do not invent facts.** Non-negotiable; the whole product rests on it.
 *   - **Do not improve the sentence.** Not load-bearing at all.
 *
 * Rewriting for strength — leading with what was done, cutting the hedge —
 * adds no facts. The prompt banned it because prose has no way to tell the two
 * apart. This does: the answer *is* the grounding source, so a rewritten bullet
 * can be checked against it exactly the way a tailored resume is checked
 * against the profile. Every proper noun and every number has to trace back to
 * something the person said, or to something already on their profile.
 *
 * That is a stronger guarantee than the prompt rule it replaces, because it is
 * a check rather than an instruction.
 */

export interface VerifiedBullet {
  bullet: DraftedBullet;
  /** Empty when everything in the bullet traces back. */
  violations: Violation[];
  /** False when the bullet says something the answer does not support. */
  grounded: boolean;
}

export interface VerifiedDraft {
  kept: VerifiedBullet[];
  /** Bullets that introduced something unsupported. Never silently dropped. */
  rejected: VerifiedBullet[];
}

/**
 * The words a bullet is allowed to draw on.
 *
 * Both the answer and the profile: an answer often refers to work already on
 * file — "the same pipeline I built at Halcyon" — and the employer's own name
 * is not a fabrication just because this particular sentence introduced it.
 */
export function answerLexicon(answer: string, profile: Profile): Set<string> {
  return buildLexicon({ answer, profile });
}

/**
 * Verifies drafted bullets against the answer that produced them.
 *
 * Only high-severity findings reject a bullet. Those are the checkable ones —
 * a number or a proper noun that appears nowhere in the answer or the profile.
 * A capitalised sentence opener is ambiguous by nature and is reported without
 * throwing the bullet away, exactly as it is in the tailoring guard.
 */
export function verifyDraft(
  bullets: DraftedBullet[],
  answer: string,
  profile: Profile,
): VerifiedDraft {
  const lexicon = answerLexicon(answer, profile);
  const kept: VerifiedBullet[] = [];
  const rejected: VerifiedBullet[] = [];

  for (const bullet of bullets) {
    const violations = checkText(bullet.text, lexicon, 'drafted').violations;
    const blocking = violations.filter((v) => v.severity === 'high');
    const entry = { bullet, violations, grounded: blocking.length === 0 };
    (entry.grounded ? kept : rejected).push(entry);
  }

  return { kept, rejected };
}

/**
 * Whether an answer deserves one more question rather than being written up.
 *
 * The `uncertain` flag has existed since the schema was written and nothing has
 * ever read it — the model was being asked to say when it had to guess, and the
 * answer was thrown away. Meanwhile "I've used it a bit, we had containers for
 * some stuff" produced no bullets at all and the interview simply moved on,
 * which is the moment a person would have asked what was in the containers.
 *
 * Deliberately conservative. Being asked twice about the same thing is
 * irritating in a way that being asked once is not, so this fires only when
 * there is a real reason and callers are expected to allow one per question.
 */
export function needsFollowUp(
  verified: VerifiedDraft,
  answer: string,
): { follow: boolean; because: string } {
  const words = answer.trim().split(/\s+/).filter(Boolean).length;

  // Nothing came back from something they clearly meant as an answer. Under
  // ten words is a shrug, and a shrug is a complete reply.
  if (verified.kept.length === 0 && verified.rejected.length === 0 && words >= 10) {
    return {
      follow: true,
      because: 'nothing in that was specific enough to write down',
    };
  }

  if (verified.rejected.length > 0) {
    return {
      follow: true,
      because: 'part of what came back was not supported by the answer',
    };
  }

  if (verified.kept.some((b) => b.bullet.uncertain)) {
    return { follow: true, because: 'the answer left something open to interpretation' };
  }

  return { follow: false, because: '' };
}
