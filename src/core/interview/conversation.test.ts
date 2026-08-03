import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { applyQuickReply, lanesFor, progress, quickReplies } from './conversation';
import { findGaps } from './gaps';
import type { Gap } from './gaps';

/**
 * The conversation layer.
 *
 * Two properties matter more than the rest: a tap that needs no model must not
 * make a model call, and a reply must never leave the profile in a state the
 * person did not ask for.
 */

const NOW = '2026-08-03T00:00:00.000Z';

function profile(over: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    id: 'prf_1',
    createdAt: NOW,
    updatedAt: NOW,
    basics: { name: 'Priya Raman' },
    work: [
      {
        id: 'wrk_1',
        name: 'Halcyon Fleet',
        position: 'Lead Mobile Developer',
        startDate: '05/2022',
        endDate: '',
        bullets: [{ id: 'blt_1', text: 'Refactored the geolocation layer to cut battery drain.' }],
      },
    ],
    skills: [
      { id: 'skl_1', name: 'Languages', keywords: ['Swift', 'C#', 'TypeScript'] },
      { id: 'skl_2', name: 'Cloud', keywords: ['Firebase (Authentication, Firestore)'] },
    ],
    ...over,
  });
}

const gap = (over: Partial<Gap> = {}): Gap => ({
  id: 'unbacked:c#',
  kind: 'unbacked-skill',
  subject: 'C#',
  ownerId: null,
  ownerLabel: 'Languages',
  why: 'You list C# as a skill, but no bullet shows you using it.',
  weight: 40,
  ...over,
});

describe('what a person is offered', () => {
  it('gives every question a way out that is not typing', () => {
    for (const kind of ['recent-work', 'unbacked-skill', 'thin-role', 'missing-requirement'] as const) {
      expect(quickReplies(gap({ kind })).length, kind).toBeGreaterThan(0);
    }
  });

  it('offers nothing to tap for a summary, because that answer has to be theirs', () => {
    expect(quickReplies(gap({ kind: 'no-summary' }))).toEqual([]);
  });

  it('keeps the list short enough not to be a form again', () => {
    for (const kind of ['recent-work', 'unbacked-skill', 'thin-role', 'missing-requirement'] as const) {
      expect(quickReplies(gap({ kind })).length, kind).toBeLessThanOrEqual(3);
    }
  });

  it('names the subject in the follow-up, so the text box is not a blank page', () => {
    const used = quickReplies(gap({ subject: 'Kotlin' })).find((r) => r.id === 'used');
    expect(used?.followUp).toContain('Kotlin');
  });

  it('lets every question be dismissed instantly, with no model call', () => {
    // The property that decides how the thing feels: saying "no" or "nothing
    // to add" must never make someone wait on a provider.
    for (const kind of ['recent-work', 'unbacked-skill', 'thin-role', 'missing-requirement'] as const) {
      const instant = quickReplies(gap({ kind })).filter((r) => r.immediate);
      expect(instant.length, `${kind} has no instant reply`).toBeGreaterThan(0);
    }
  });

  it('needs a model for the replies that actually add something', () => {
    // The other half. Anything that produces content has to be interpreted,
    // and pretending otherwise would mean guessing at what someone meant.
    const adding = quickReplies(gap()).filter((r) => r.lane === 'bullet');
    expect(adding.every((r) => !r.immediate && r.followUp)).toBe(true);
  });
});

describe('taking an unevidenced skill off the resume', () => {
  // The lane that did not exist. "I'm only learning it" used to produce
  // nothing, so the claim stayed on the resume unevidenced.
  it('removes the keyword the question was about', () => {
    const result = applyQuickReply(profile(), gap(), 'learning', NOW);

    expect(result.changed).toBe(true);
    expect(result.summary).toContain('C#');
    expect(result.profile.skills[0]?.keywords).toEqual(['Swift', 'TypeScript']);
  });

  it('matches the head of a compound entry', () => {
    const g = gap({ id: 'unbacked:firebase', subject: 'Firebase', ownerLabel: 'Cloud' });
    const result = applyQuickReply(profile(), g, 'learning', NOW);

    expect(result.profile.skills.map((s) => s.name)).not.toContain('Cloud');
  });

  it('drops a group left with nothing in it', () => {
    // A heading with no keywords under it reads as an oversight on the page.
    const one = profileSchema.parse({
      ...profile(),
      skills: [{ id: 'skl_1', name: 'Languages', keywords: ['C#'] }],
    });
    expect(applyQuickReply(one, gap(), 'learning', NOW).profile.skills).toEqual([]);
  });

  it('touches nothing else', () => {
    const before = profile();
    const after = applyQuickReply(before, gap(), 'learning', NOW).profile;

    expect(after.work).toEqual(before.work);
    expect(after.basics).toEqual(before.basics);
  });

  it('does nothing when the keyword is already gone', () => {
    const result = applyQuickReply(profile(), gap({ subject: 'Haskell' }), 'learning', NOW);
    expect(result.changed).toBe(false);
    expect(result.profile).toEqual(profile());
  });
});

describe('taps that only close a question', () => {
  it('changes nothing for "still there"', () => {
    const before = profile();
    const result = applyQuickReply(before, gap({ kind: 'recent-work', subject: 'Any newer role' }), 'same', NOW);

    expect(result.changed).toBe(false);
    expect(result.profile).toEqual(before);
    expect(result.summary).toBeTruthy();
  });

  it('changes nothing for an honest "no, I havent"', () => {
    const g = gap({ kind: 'missing-requirement', subject: 'Kubernetes' });
    expect(applyQuickReply(profile(), g, 'not', NOW).changed).toBe(false);
  });
});

describe('replies that still need interpreting', () => {
  it('does not act on a tap that is only half an answer', () => {
    // "I've left" needs a date. Committing anything here would be a guess.
    const g = gap({ kind: 'recent-work', subject: 'Any newer role' });
    const result = applyQuickReply(profile(), g, 'left', NOW);

    expect(result.changed).toBe(false);
    expect(result.summary).toBe('');
    expect(quickReplies(g).find((r) => r.id === 'left')?.followUp).toBeTruthy();
  });

  it('ignores a reply id that is not on offer', () => {
    expect(applyQuickReply(profile(), gap(), 'nonsense', NOW).changed).toBe(false);
  });
});

describe('which lanes a reply may open', () => {
  it('lets one answer about a job carry a departure, an employer and a bullet', () => {
    // "I left in November, I'm at Foundry now, and I rebuilt their sync layer"
    // is three facts in one sentence.
    expect(lanesFor('recent-work')).toEqual(expect.arrayContaining(['end-role', 'new-role', 'bullet']));
  });

  it('keeps a summary out of every other lane', () => {
    expect(lanesFor('no-summary')).toEqual(['summary']);
  });
});

describe('progress', () => {
  it('falls by more than one when a reply settles several questions', () => {
    // The reason this reads as a conversation rather than a form.
    const before = progress(8, 0);
    const after = progress(5, 1, before.remaining);

    expect(before.remaining).toBe(8);
    expect(after.remaining).toBe(5);
  });

  it('never goes backwards, even if a new gap appears', () => {
    // Answering can surface a gap that was not visible before — a new employer
    // with no bullets. Honest, but a progress bar that grows reads as broken.
    const first = progress(6, 1);
    const second = progress(9, 2, first.remaining);

    expect(second.remaining).toBeLessThanOrEqual(first.remaining);
  });

  it('reads as complete when nothing is left', () => {
    expect(progress(0, 5).fraction).toBe(1);
  });
});

describe('against the real gap finder', () => {
  it('offers a tap for every question it would actually ask', () => {
    const gaps = findGaps(profile(), { now: new Date(NOW), limit: 8 });
    expect(gaps.length).toBeGreaterThan(0);

    for (const g of gaps) {
      const replies = quickReplies(g);
      // A summary is the one question with nothing to tap.
      if (g.kind === 'no-summary') continue;
      expect(replies.length, `${g.kind} · ${g.subject}`).toBeGreaterThan(0);
    }
  });

  it('can take an unevidenced skill straight off, end to end', () => {
    const gaps = findGaps(profile(), { now: new Date(NOW), limit: 8 });
    const cSharp = gaps.find((g) => g.subject === 'C#');
    expect(cSharp).toBeDefined();

    const after = applyQuickReply(profile(), cSharp!, 'learning', NOW).profile;
    expect(after.skills.flatMap((s) => s.keywords)).not.toContain('C#');

    // And the question does not come back.
    const remaining = findGaps(after, { now: new Date(NOW), limit: 8 });
    expect(remaining.map((g) => g.subject)).not.toContain('C#');
  });
});
