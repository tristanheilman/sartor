import type { Profile } from '../schema';
import type { Gap, GapKind } from './gaps';

/**
 * Turning an interview into a conversation.
 *
 * The gap finder decides *what* to ask and `ask.ts` decides *how*. This is the
 * layer between them and a person: what a reply may turn into, and how much of
 * that can be settled without a model call.
 *
 * Two things shape it.
 *
 * **Most replies are one of a few answers.** "Still there." "I left." "I only
 * ever read those files." Offering those as one tap is faster than typing, and
 * every question has at least one tap that resolves with no model call at all
 * — so a question can always be dismissed instantly, and the conversation
 * never makes someone wait to say "no".
 *
 * **A long reply usually contains more than one fact.** "I left in November,
 * I'm at Foundry now, and I rebuilt their sync layer" is a departure, an
 * employer and a bullet. The lanes below are the shapes the rest of the system
 * can actually act on, so an answer is sorted into them rather than being taken
 * as prose — and anything that fits no lane is surfaced as unused rather than
 * quietly dropped.
 */

/** What a reply can turn into. Everything downstream consumes one of these. */
export type LaneKind =
  | 'bullet'
  | 'new-role'
  | 'end-role'
  | 'summary'
  | 'drop-skill'
  | 'none';

export interface QuickReply {
  id: string;
  /** What the person taps. Their words, not the system's. */
  label: string;
  lane: LaneKind;
  /**
   * Set when the reply is only half an answer — tapping it should open the
   * text box with this as the prompt, rather than committing anything.
   */
  followUp?: string;
  /**
   * True when this resolves with no model call: the profile change is already
   * determined by the tap.
   */
  immediate: boolean;
}

const reply = (
  id: string,
  label: string,
  lane: LaneKind,
  opts: { followUp?: string; immediate?: boolean } = {},
): QuickReply => ({ id, label, lane, immediate: opts.immediate ?? false, ...opts });

/**
 * The taps offered alongside a question.
 *
 * Deliberately few. A list of eight options is a form again, and the whole
 * point is that the text box is always there for anything these do not cover.
 */
export function quickReplies(gap: Gap): QuickReply[] {
  switch (gap.kind) {
    case 'recent-work':
      return [
        reply('same', 'Still there', 'none', { immediate: true }),
        reply('left', "I've left", 'end-role', { followUp: 'When did you leave?' }),
        reply('new', "I'm somewhere new", 'new-role', {
          followUp: 'Where are you now, and what are you doing there?',
        }),
      ];

    case 'unbacked-skill':
      return [
        reply('used', 'I use it at work', 'bullet', {
          followUp: `What did you build with ${gap.subject}?`,
        }),
        // The lane that did not exist. An unevidenced keyword is the weakest
        // line on a resume, and "I am learning it" produced nothing at all —
        // the claim simply stayed. Taking it off is a real, honest outcome.
        reply('learning', 'Only learning it', 'drop-skill', { immediate: true }),
        reply('keep', 'Leave it, no story to tell', 'none', { immediate: true }),
      ];

    case 'thin-role':
      return [
        reply('more', 'There is more to say', 'bullet', {
          followUp: `What else did you do at ${gap.subject}?`,
        }),
        reply('enough', "That's the whole job", 'none', { immediate: true }),
      ];

    case 'undated-role':
      return [reply('dates', 'Add the dates', 'end-role', { followUp: 'When did that role run?' })];

    case 'missing-requirement':
      return [
        reply('have', "I've done this", 'bullet', {
          followUp: `Where did you use ${gap.subject}?`,
        }),
        // Recording a real gap is worth as much as filling one. It stops the
        // question coming back and it is the honest answer.
        reply('not', "No, I haven't", 'none', { immediate: true }),
      ];

    case 'no-summary':
      // Nothing to offer. A summary is the one answer that has to be theirs.
      return [];
  }
}

/** Lanes a reply to this gap could produce, for prompting and for validation. */
export function lanesFor(kind: GapKind): LaneKind[] {
  switch (kind) {
    case 'recent-work':
      return ['new-role', 'end-role', 'bullet', 'none'];
    case 'unbacked-skill':
      return ['bullet', 'drop-skill', 'none'];
    case 'no-summary':
      return ['summary'];
    case 'undated-role':
      return ['end-role', 'none'];
    default:
      return ['bullet', 'none'];
  }
}

/* ------------------------------------------------------------------ *
 * Replies that need no model
 * ------------------------------------------------------------------ */

export interface ImmediateResult {
  /** The profile after the tap. Unchanged for a reply that only closes a gap. */
  profile: Profile;
  /** One line for the transcript, in the past tense, describing what happened. */
  summary: string;
  changed: boolean;
}

/**
 * Applies a tap that needs no interpretation.
 *
 * Keeping these off the model is most of what makes the conversation feel
 * quick: "Still there" and "only learning it" are unambiguous, and a round trip
 * to a provider to discover that would be latency spent on nothing.
 */
export function applyQuickReply(
  profile: Profile,
  gap: Gap,
  replyId: string,
  now = new Date().toISOString(),
): ImmediateResult {
  const chosen = quickReplies(gap).find((r) => r.id === replyId);

  if (!chosen?.immediate) {
    return { profile, summary: '', changed: false };
  }

  if (chosen.lane === 'drop-skill') {
    const target = gap.subject.trim().toLowerCase();
    let removed = false;

    const skills = profile.skills.map((group) => ({
      ...group,
      keywords: group.keywords.filter((keyword) => {
        // Match the head of a compound entry, so "Firebase (Auth, Firestore)"
        // is removed by a question about Firebase.
        const head = (keyword.split(/[(/,]/)[0] ?? keyword).trim().toLowerCase();
        const hit = head === target || keyword.trim().toLowerCase() === target;
        if (hit) removed = true;
        return !hit;
      }),
    }));

    if (!removed) return { profile, summary: '', changed: false };

    return {
      // Empty groups are dropped: a heading with nothing under it reads as an
      // oversight on the page.
      profile: { ...profile, skills: skills.filter((g) => g.keywords.length > 0), updatedAt: now },
      summary: `Removed ${gap.subject} from your skills.`,
      changed: true,
    };
  }

  // 'none' — answered, nothing to change. Recorded so it is not asked again.
  return { profile, summary: 'Noted, nothing to change.', changed: false };
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export interface Progress {
  answered: number;
  remaining: number;
  /** Answered out of everything raised so far, 0–1. */
  fraction: number;
}

/**
 * How far through the questions we are.
 *
 * `remaining` is recomputed from the gaps that are still open rather than
 * counted down, so it falls by more than one when a single reply settles
 * several questions — which is the whole reason this reads as a conversation
 * and not a form. It is never allowed to grow, because a progress bar that
 * goes backwards reads as broken even when it is honest.
 */
export function progress(openGaps: number, answered: number, previousRemaining?: number): Progress {
  const remaining = previousRemaining === undefined ? openGaps : Math.min(openGaps, previousRemaining);
  const total = answered + remaining;
  return { answered, remaining, fraction: total === 0 ? 1 : answered / total };
}
