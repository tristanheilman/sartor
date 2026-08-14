import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import {
  applyQuickReply,
  bestOwner,
  currentQuestion,
  followUpQuestion,
  repliesFor,
  placeBullet,
  confirmPlacement,
  lanesFor,
  progress,
  quickReplies,
} from './conversation';
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

  it('offers nothing to tap when there is no work history at all', () => {
    // "Where have you worked?" was being offered "Still there", which is not
    // an answer to it. Same kind, different question.
    expect(quickReplies(gap({ kind: 'recent-work', id: 'recent:none' }))).toEqual([]);
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
      // Two questions have nothing sensible to tap: a summary, and "where have
      // you worked" on a profile with no history.
      if (g.kind === 'no-summary' || g.id === 'recent:none') continue;
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

describe('where an answer belongs', () => {
  // From a real interview: seven of eight bullets landed on a job the person
  // had held for two months, because the rule was "use the most recent one"
  // and skills like Redux and Jest span several jobs.
  const twoJobs = profileSchema.parse({
    id: 'prf_1',
    createdAt: NOW,
    updatedAt: NOW,
    basics: { name: 'Priya Raman' },
    work: [
      {
        id: 'wrk_new',
        name: 'Foundry Health',
        position: 'Senior Engineer',
        startDate: '11/2025',
        endDate: '',
        bullets: [{ id: 'b1', text: 'Built the Auth0 integration and the anonymization scripts.' }],
      },
      {
        id: 'wrk_old',
        name: 'Halcyon Fleet',
        position: 'Lead Mobile Developer',
        startDate: '05/2022',
        endDate: '09/2025',
        bullets: [
          { id: 'b2', text: 'Refactored driver tracking geolocation with GPS polling.' },
          { id: 'b3', text: 'Developed CI/CD pipelines using Fastlane.' },
        ],
      },
    ],
  });

  it('sends an answer to the job whose work it actually resembles', () => {
    const guess = bestOwner(twoJobs, 'I set up the Fastlane pipelines and did the geolocation work there.');
    expect(guess?.ownerId).toBe('wrk_old');
  });

  it('does not default to the newest job', () => {
    // The exact failure. Under the old rule this went to Foundry Health.
    const guess = bestOwner(twoJobs, 'GPS polling and driver tracking.');
    expect(guess?.ownerId).not.toBe('wrk_new');
  });

  it('follows the employer when the answer names one', () => {
    expect(bestOwner(twoJobs, 'That was at Foundry Health.')?.ownerId).toBe('wrk_new');
  });

  it('declines to guess when nothing points anywhere', () => {
    // Better one more question than work filed under the wrong employer.
    expect(bestOwner(twoJobs, 'It went pretty well overall.')).toBeNull();
  });

  it('says why, so the guess can be checked', () => {
    expect(bestOwner(twoJobs, 'Fastlane and CI/CD pipelines.')?.reason).toContain('Halcyon Fleet');
  });
});

describe('projects', () => {
  it('asks about a project that is barely described', () => {
    const withThin = profileSchema.parse({
      ...profile(),
      projects: [{ id: 'prj_1', name: 'react-native-object-capture', bullets: [{ id: 'pb1', text: 'A public React Native library.' }] }],
    });
    const gaps = findGaps(withThin, { now: new Date(NOW), limit: 12 });

    expect(gaps.map((g) => g.subject)).toContain('react-native-object-capture');
  });

  it('asks whether there are projects it has never been told about', () => {
    // Nothing read profile.projects at all, so a published package could never
    // come up however much work it represented.
    const gaps = findGaps(profile(), { now: new Date(NOW), limit: 12 });
    expect(gaps.map((g) => g.kind)).toContain('more-projects');
  });

  it('offers a tap for both project questions', () => {
    for (const kind of ['more-projects', 'thin-project'] as const) {
      expect(quickReplies(gap({ kind })).length, kind).toBeGreaterThan(0);
      expect(quickReplies(gap({ kind })).some((r) => r.immediate), kind).toBe(true);
    }
  });
});

describe('which question stays on screen', () => {
  const sartor: Gap = {
    id: 'thin-project:prj_sartor',
    kind: 'thin-project',
    subject: 'Sartor',
    ownerId: 'prj_sartor',
    ownerLabel: 'Sartor',
    why: 'Sartor has only 2 lines describing it.',
    weight: 58,
  };
  const swing: Gap = { ...sartor, id: 'thin-project:prj_swing', subject: 'diy-swing-analysis', ownerId: 'prj_swing' };

  it('shows the highest-ranked gap when nothing is pinned', () => {
    expect(currentQuestion(null, [sartor, swing])?.id).toBe(sartor.id);
  });

  it('keeps a pinned question after answering has filled its gap', () => {
    // The real sequence: describing Sartor took it from 2 bullets to 6, so
    // `thin-project` stopped firing for it and it left the open list entirely
    // — while a follow-up about it was still on screen awaiting an answer.
    expect(currentQuestion(sartor, [swing])?.subject).toBe('Sartor');
  });

  it('keeps a pinned question when the ranking reshuffles under it', () => {
    expect(currentQuestion(sartor, [swing, sartor])?.id).toBe(sartor.id);
  });

  it('has nothing to ask when the list empties and nothing is pinned', () => {
    expect(currentQuestion(null, [])).toBeNull();
  });

  it('still has the pinned question when the list empties completely', () => {
    // Answering the last open gap must not close the follow-up it just asked.
    expect(currentQuestion(sartor, [])?.id).toBe(sartor.id);
  });
});

describe('the question asked when the model supplies none', () => {
  const skill: Gap = {
    id: 'unbacked:azure-devops',
    kind: 'unbacked-skill',
    subject: 'Azure DevOps',
    ownerId: null,
    ownerLabel: 'Tools',
    why: 'You list Azure DevOps as a skill, but no bullet shows you using it.',
    weight: 90,
  };

  it('prefers the model’s own follow-up, which is specific to the answer', () => {
    expect(followUpQuestion(skill, 'What did the pipelines actually do?')).toBe(
      'What did the pipelines actually do?',
    );
  });

  it('falls back to a question about the subject rather than staying silent', () => {
    // "I used Azure DevOps at Wridz for a very short period of time. The work
    // and commits were in a private company repo." — 23 words, no bullet
    // earned, and no follow-up from the model. `needsFollowUp` said to ask;
    // the panel had nothing to ask with, so it moved on instead.
    const q = followUpQuestion(skill, '');
    expect(q).toContain('Azure DevOps');
    expect(q.trim()).not.toBe('');
  });

  it('never falls back to a bare "tell me more"', () => {
    // The prompt forbids this of the model for good reason; the fallback must
    // hold to the same rule or it undoes it.
    expect(followUpQuestion(skill, '')).not.toMatch(/tell me more|more about/i);
  });

  it('asks about authorship for a project, not about usage', () => {
    const project: Gap = {
      ...skill,
      id: 'thin-project:prj_1',
      kind: 'thin-project',
      subject: 'react-native-island',
      ownerId: 'prj_1',
    };
    expect(followUpQuestion(project, '')).toContain('react-native-island');
  });

  it('has something to ask for every kind of gap', () => {
    const kinds: Gap['kind'][] = [
      'recent-work',
      'more-projects',
      'thin-project',
      'missing-requirement',
      'unbacked-skill',
      'thin-role',
      'undated-role',
      'no-summary',
    ];
    for (const kind of kinds) {
      expect(followUpQuestion({ ...skill, kind }, '').trim(), kind).not.toBe('');
    }
  });
});

describe('the way out of a follow-up', () => {
  const skill = gap({ id: 'unbacked:azure', subject: 'Azure DevOps' });

  it('offers every reply when a question is first asked', () => {
    expect(repliesFor(skill, false)).toEqual(quickReplies(skill));
  });

  it('keeps the replies that need no model while a follow-up is pending', () => {
    // The case this exists for. Asked what they used Azure DevOps for, the
    // honest answer was "I guess I didn't really use it" — and the only reply
    // that acts on that had been hidden, because a pending follow-up wants
    // typing. The escape hatch has to survive the question being asked twice.
    const during = repliesFor(skill, true);

    expect(during.length).toBeGreaterThan(0);
    expect(during.every((r) => r.immediate)).toBe(true);
    expect(during.some((r) => r.lane === 'drop-skill')).toBe(true);
  });

  it('drops the replies that would only reopen the box', () => {
    // "I use it at work" sets the prompt and focuses the textarea, which is
    // where the person already is.
    expect(repliesFor(skill, true).some((r) => r.followUp)).toBe(false);
  });

  it('leaves a summary question with nothing to tap, as before', () => {
    expect(repliesFor(gap({ kind: 'no-summary' }), true)).toEqual([]);
  });
});

describe('saying a skill is not really yours', () => {
  it('does not require having been learning it', () => {
    // The label was "Only learning it", which is one reason a skill has no
    // story behind it and not the common one. "I didn't really use it" had no
    // button, so an honest answer had nowhere to go.
    const drop = quickReplies(gap()).find((r) => r.lane === 'drop-skill');

    expect(drop).toBeDefined();
    expect(drop?.label).not.toMatch(/learning/i);
    expect(drop?.immediate).toBe(true);
  });
});

describe('how confident the placement is', () => {
  const p = profile({
    work: [
      {
        id: 'wrk_new',
        name: 'Formedics',
        position: 'Native App Developer',
        startDate: '10/2025',
        endDate: '',
        bullets: [{ id: 'b1', text: 'Built the Auth0 integration for Figure1.' }],
      },
      {
        id: 'wrk_old',
        name: 'Wridz LLC',
        position: 'Lead Mobile App Developer',
        startDate: '05/2022',
        endDate: '09/2025',
        bullets: [{ id: 'b2', text: 'Refactored driver tracking geolocation and GPS polling.' }],
      },
    ],
  });
  const g = gap();

  it('is certain when the model named the role itself', () => {
    const placed = placeBullet('wrk_old', g, null, p.work[0]!.id);
    expect(placed).toMatchObject({ ownerId: 'wrk_old', certain: true });
  });

  it('is certain when the question was already about one entry', () => {
    const owned = gap({ kind: 'thin-role', ownerId: 'wrk_old' });
    const placed = placeBullet('', owned, null, p.work[0]!.id);

    expect(placed.ownerId).toBe('wrk_old');
    expect(placed.certain).toBe(true);
    expect(placed.confidence).toBe(1);
  });

  it('is certain when the answer clearly points at a role', () => {
    const guess = bestOwner(p, 'I refactored the driver tracking geolocation and GPS polling at Wridz');
    expect(guess).not.toBeNull();

    const placed = placeBullet('', g, guess, p.work[0]!.id);
    expect(placed.ownerId).toBe('wrk_old');
    expect(placed.certain).toBe(true);
  });

  it('is not certain when nothing in the answer pointed anywhere', () => {
    // The real case: "I have used Firebase Cloud Messaging" names no employer,
    // so the bullet landed on a role by position rather than by evidence — and
    // looked exactly like one placed on evidence.
    const placed = placeBullet('', g, null, p.work[0]!.id);

    expect(placed.ownerId).toBe('wrk_new');
    expect(placed.certain).toBe(false);
    expect(placed.confidence).toBe(0);
    expect(placed.reason).toBeTruthy();
  });

  it('is not certain on a weak match', () => {
    const weak = { ownerId: 'wrk_old', confidence: 0.25, reason: 'Shares a word or two.' };
    expect(placeBullet('', g, weak, p.work[0]!.id).certain).toBe(false);
  });

  it('prefers the model over the guess, and the guess over position', () => {
    const guess = { ownerId: 'wrk_old', confidence: 0.9, reason: 'x' };
    expect(placeBullet('wrk_new', g, guess, 'wrk_old').ownerId).toBe('wrk_new');
    expect(placeBullet('', g, guess, 'wrk_new').ownerId).toBe('wrk_old');
  });

  it('has nothing to place when there are no roles at all', () => {
    expect(placeBullet('', g, null, '').ownerId).toBe('');
    expect(placeBullet('', g, null, '').certain).toBe(true);
  });
});

describe('asking whether a placement is right', () => {
  it('names the role it chose and offers to move it', () => {
    const q = confirmPlacement('Lead Mobile App Developer at Wridz LLC');

    expect(q).toContain('Lead Mobile App Developer at Wridz LLC');
    expect(q).toMatch(/\?$/);
  });

  it('does not ask a yes-or-no question that dead-ends', () => {
    // "Is that right?" invites "no" and nothing else. The reply has to be able
    // to carry the correction.
    expect(confirmPlacement('Native App Developer at Formedics')).toMatch(/where|which|somewhere/i);
  });
});
