import type { Profile } from '../schema';
import { tokenize } from '../tailor/lexicon';
import { isCommonSentenceOpener } from '../tailor/stopwords';
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
      // An empty history has nothing to still be at. The only useful reply is
      // theirs, so offer nothing and let the box do the work.
      if (gap.id === 'recent:none') return [];
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

    case 'more-projects':
      return [
        reply('add', 'I have some to add', 'bullet', {
          followUp: 'Which projects or packages, and what does each one do?',
        }),
        reply('none', "That's all of them", 'none', { immediate: true }),
      ];

    case 'thin-project':
      return [
        reply('describe', 'Let me describe it', 'bullet', {
          followUp: `What does ${gap.subject} do, and what did you build in it?`,
        }),
        reply('enough', "That's enough about it", 'none', { immediate: true }),
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
    case 'more-projects':
    case 'thin-project':
      return ['bullet', 'none'];
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

/* ------------------------------------------------------------------ *
 * Where an answer belongs
 * ------------------------------------------------------------------ */

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(text)) if (!isCommonSentenceOpener(t.norm)) out.add(t.norm);
  return out;
}

export interface OwnerGuess {
  ownerId: string;
  /** 0–1. Zero means nothing in the answer pointed anywhere. */
  confidence: number;
  /** Why, in a sentence, for the confirmation step. */
  reason: string;
}

/**
 * Which role an answer is about, when the answer does not say.
 *
 * The rule used to be "use the most recent one", and it was wrong in the way
 * that matters: skills like Redux, Jest and JIRA span several jobs, so *every*
 * unattributed answer piled onto the current employer. Seven of eight bullets
 * from one real interview landed on a job the person had held for two months.
 *
 * Recency is the worst available tie-break. What the profile already says is a
 * far better one: if a role's existing bullets talk about React Native and the
 * answer talks about React Native, that is evidence, and it is evidence the
 * user can check when they confirm.
 *
 * Returns nothing when nothing points anywhere. A caller that cannot tell
 * should ask rather than guess — silently filing work under the wrong employer
 * is worse than one more question.
 */
export function bestOwner(profile: Profile, answer: string): OwnerGuess | null {
  const words = contentTokens(answer);
  if (words.size === 0 || profile.work.length === 0) return null;

  let best: OwnerGuess | null = null;

  for (const role of profile.work) {
    // The employer and title count as evidence too: naming the company in an
    // answer is the clearest signal there is.
    const haystack = contentTokens(
      [role.name, role.position, ...role.bullets.map((b) => b.text)].join(' '),
    );
    if (haystack.size === 0) continue;

    let shared = 0;
    for (const w of words) if (haystack.has(w)) shared++;
    const confidence = shared / words.size;

    if (!best || confidence > best.confidence) {
      best = {
        ownerId: role.id,
        confidence,
        reason: `${shared} of the things you mentioned already appear under ${role.position} at ${role.name}`,
      };
    }
  }

  // One or two incidental words in common is noise, not a signal.
  return best && best.confidence >= 0.2 ? best : null;
}

/**
 * Which question is on screen.
 *
 * A question with a follow-up pending must stay put, and the obvious way to do
 * that — hold its id and look it up again — fails in the one case that matters.
 * Answering a question usually *fills the gap it came from*: describe a project
 * with two lines and it now has six, so `thin-project` no longer fires for it
 * and the id resolves to nothing. The lookup then falls through to whatever gap
 * is now first, and the follow-up is asked under someone else's heading.
 *
 * Holding the gap itself keeps the question stable through exactly that, which
 * is the normal outcome of answering rather than an edge case. The pin is
 * cleared when the answer settles, so a stale gap cannot outlive its question.
 */
export function currentQuestion(pinned: Gap | null, openGaps: Gap[]): Gap | null {
  return pinned ?? openGaps[0] ?? null;
}
