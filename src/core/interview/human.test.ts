import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { INTERVIEW_SYSTEM_PROMPT, buildAnswerPrompt } from './ask';
import { needsFollowUp, verifyDraft } from './verify';
import type { DraftedBullet } from './ask';
import type { Gap } from './gaps';

/**
 * How people actually answer.
 *
 * Every fixture in this repo was written by someone who knew what a good
 * answer looked like. Real answers hedge, apologise, think out loud and bury
 * one solid fact under four caveats — and the first real answer given to this
 * thing produced nothing at all, because the apologies drowned the fact.
 *
 * The corpus below is verbatim from a real session, or written in the same
 * register. It exists because synthetic fixtures never hedge, and hedging is
 * the normal case.
 */

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: 'now',
  updatedAt: 'now',
  basics: { name: 'Priya Raman' },
  work: [{ id: 'wrk_1', name: 'Halcyon Fleet', position: 'Lead Mobile Developer', bullets: [] }],
  projects: [{ id: 'prj_1', name: 'react-native-island', bullets: [] }],
});

const drafted = (text: string, over: Partial<DraftedBullet> = {}): DraftedBullet => ({
  text,
  ownerId: '',
  uncertain: false,
  basis: '',
  ...over,
});

/** Answers as given, hedges and all. */
const REAL_ANSWERS = {
  hedgedButConcrete:
    "I originally started it when working for Halcyon because it was a need. It still needs work and maybe refactors for modern things I'm unaware of. I worked on it recently to make changes and update things. It's a tool for react native apps to expose iOS live activities and android notifications. It's not perfect and there could be alternatives like android bubbles that may become an alternative.",
  shrug: "I've used it a bit. We had containers for some stuff.",
  honestNo:
    "Honestly no, I don't have professional C# experience. I put it on there because I was working through a course.",
  scopedDown:
    "I don't build in Figma, but I work out of designers' Figma files daily — going through the specs, flagging things that won't work on small Android screens before we build them.",
};

describe('the system prompt tells it what people are like', () => {
  it('says an answer can be concrete and vague at once', () => {
    // The failure this exists for: one solid fact wrapped in four apologies
    // produced no bullets at all.
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/concrete in one place and vague in another/i);
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/while still returning the bullets/i);
  });

  it('names hedging as something to look past, not to be stopped by', () => {
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/hedging/i);
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/not perfect/);
    // Collapsed, because the prompt is hard-wrapped and the phrase spans lines.
    expect(INTERVIEW_SYSTEM_PROMPT.replace(/\s+/g, ' ')).toMatch(
      /Never let hedging talk you out of a bullet/i,
    );
  });

  it('still forbids upgrading what was said', () => {
    // Reading past a hedge is not licence to inflate. "helped with" is not
    // "led", however confident the rewrite sounds.
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/Never upgrade scope/i);
    expect(INTERVIEW_SYSTEM_PROMPT).toMatch(/"we" is not "I"/);
  });
});

describe('a hedged answer that still contains a fact', () => {
  const gap: Gap = {
    id: 'thin-project:prj_1',
    kind: 'thin-project',
    subject: 'react-native-island',
    ownerId: 'prj_1',
    ownerLabel: 'react-native-island',
    why: 'only 1 line describing it',
    weight: 58,
  };

  it('reaches the model with the hedges intact, not pre-cleaned', () => {
    // Stripping them before the model sees them would be us deciding what
    // mattered. The prompt's job is to read past them.
    const prompt = buildAnswerPrompt(gap, 'What is it?', REAL_ANSWERS.hedgedButConcrete, profile);
    expect(prompt).toContain("It's not perfect");
    expect(prompt).toContain('expose iOS live activities and android notifications');
  });

  it('keeps the bullet and asks about the vague part, rather than choosing', () => {
    // What should have happened: the definition is writable, "I worked on it
    // recently to make changes" is not, and both facts are in one answer.
    const verified = verifyDraft(
      [
        drafted('Built a React Native library exposing iOS Live Activities and Android notifications.'),
        drafted('Made recent updates to the library.', { uncertain: true }),
      ],
      REAL_ANSWERS.hedgedButConcrete,
      profile,
    );

    expect(verified.kept).toHaveLength(2);
    expect(needsFollowUp(verified, REAL_ANSWERS.hedgedButConcrete).follow).toBe(true);
  });

  it('does not let a hedge become a fabricated qualifier', () => {
    // "It still needs work" must not turn into a claim about maturity or scale
    // that the answer never made.
    const verified = verifyDraft(
      [drafted('Built a production-grade React Native library used by 10,000 apps.')],
      REAL_ANSWERS.hedgedButConcrete,
      profile,
    );
    expect(verified.rejected).toHaveLength(1);
  });
});

describe('answers that genuinely contain nothing', () => {
  it('asks again for a shrug', () => {
    expect(needsFollowUp({ kept: [], rejected: [] }, REAL_ANSWERS.shrug).follow).toBe(true);
  });

  it('accepts a clear no without pushing', () => {
    // An honest "no" is a complete answer, and asking twice is badgering.
    const verified = { kept: [], rejected: [] };
    expect(needsFollowUp(verified, REAL_ANSWERS.honestNo).follow).toBe(true);
    // ...but it must never produce a bullet from it.
    expect(verifyDraft([], REAL_ANSWERS.honestNo, profile).kept).toEqual([]);
  });
});

describe('an answer that draws its own boundary', () => {
  it('keeps the narrower claim the person actually made', () => {
    // "I don't build in Figma, but I review the files" is a scope the answer
    // sets deliberately. Widening it to "designed in Figma" is the failure.
    const verified = verifyDraft(
      [drafted('Reviewed designer Figma files daily, flagging specs that would not work on small Android screens.')],
      REAL_ANSWERS.scopedDown,
      profile,
    );
    expect(verified.kept).toHaveLength(1);
    expect(verified.rejected).toEqual([]);
  });
});
