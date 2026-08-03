import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { needsFollowUp, verifyDraft } from './verify';
import type { DraftedBullet } from './ask';

/**
 * The check that replaced a prompt rule.
 *
 * The interview used to forbid rewriting outright, which kept fabrication out
 * and also meant a weak answer became a weak bullet. Rewriting for strength
 * adds no facts; the reason it was banned is that prose cannot tell "improved
 * the sentence" from "invented a number". This can, because the answer is the
 * grounding source — so the rule is now enforced rather than requested.
 */

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: 'now',
  updatedAt: 'now',
  basics: { name: 'Priya Raman' },
  work: [
    {
      id: 'wrk_1',
      name: 'Halcyon Fleet',
      position: 'Lead Mobile Developer',
      bullets: [{ id: 'b1', text: 'Developed CI/CD pipelines using Fastlane.' }],
    },
  ],
});

const drafted = (text: string, over: Partial<DraftedBullet> = {}): DraftedBullet => ({
  text,
  ownerId: 'wrk_1',
  uncertain: false,
  basis: '',
  ...over,
});

const ANSWER =
  'I ended up owning the release process — I set up the Fastlane lanes and got us shipping weekly instead of whenever someone remembered.';

describe('rewriting for strength', () => {
  it('keeps a bullet that only says what the answer said, better', () => {
    // Every noun here comes from the answer. The sentence is stronger; the
    // facts are identical.
    const { kept, rejected } = verifyDraft(
      [drafted('Owned the release process, setting up Fastlane lanes to ship weekly.')],
      ANSWER,
      profile,
    );

    expect(rejected).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.grounded).toBe(true);
  });

  it('throws away a bullet that invents a number', () => {
    // The answer says "weekly instead of whenever someone remembered". It does
    // not say 40%, and nobody could defend it in an interview.
    const { rejected } = verifyDraft(
      [drafted('Cut release turnaround 40% by owning the Fastlane pipeline.')],
      ANSWER,
      profile,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.violations.some((v) => v.token === '40%' || v.token === '40')).toBe(true);
  });

  it('throws away a bullet that invents a tool', () => {
    const { rejected } = verifyDraft(
      [drafted('Owned the release process across Fastlane and Bitrise.')],
      ANSWER,
      profile,
    );

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.violations.some((v) => v.token === 'Bitrise')).toBe(true);
  });

  it('allows a bullet to lean on the profile as well as the answer', () => {
    // "the same pipeline I built at Halcyon" is a normal thing to say. The
    // employer is not a fabrication just because this sentence introduced it.
    const { kept } = verifyDraft(
      [drafted('Extended the Fastlane pipeline at Halcyon Fleet to ship weekly.')],
      ANSWER,
      profile,
    );

    expect(kept).toHaveLength(1);
  });

  it('reports every rejection rather than dropping it quietly', () => {
    const { kept, rejected } = verifyDraft(
      [drafted('Owned the release process.'), drafted('Shipped to 50,000 users weekly.')],
      ANSWER,
      profile,
    );

    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.bullet.text).toContain('50,000');
  });
});

describe('deciding to ask again', () => {
  const empty = { kept: [], rejected: [] };

  it('asks again when a real answer produced nothing', () => {
    // The Docker case: "I've used it a bit. We had containers for some stuff."
    // produced no bullets and the interview moved on, which is exactly where a
    // person would have asked what was in the containers.
    const vague = "I've used it a bit here and there, we had containers running for some of the services";
    expect(needsFollowUp(empty, vague).follow).toBe(true);
  });

  it('accepts a short no as a complete answer', () => {
    // "Honestly no, not really." is an answer. Pushing on it is badgering.
    expect(needsFollowUp(empty, 'Honestly no, not really.').follow).toBe(false);
  });

  it('asks again when the model had to guess', () => {
    // The `uncertain` flag existed from the start and nothing ever read it.
    const verified = {
      kept: [{ bullet: drafted('Built something with Docker.', { uncertain: true }), violations: [], grounded: true }],
      rejected: [],
    };
    expect(needsFollowUp(verified, 'long enough answer to count as a real one here').follow).toBe(true);
  });

  it('asks again when something came back unsupported', () => {
    const verified = {
      kept: [],
      rejected: [{ bullet: drafted('Cut latency 40%.'), violations: [], grounded: false }],
    };
    expect(needsFollowUp(verified, 'a reasonably long answer about the work').follow).toBe(true);
  });

  it('moves on when the answer was clear', () => {
    const verified = {
      kept: [{ bullet: drafted('Owned the release process.'), violations: [], grounded: true }],
      rejected: [],
    };
    expect(needsFollowUp(verified, ANSWER).follow).toBe(false);
  });

  it('says why, so the follow-up can explain itself', () => {
    expect(needsFollowUp(empty, "I've used it a bit, we had containers for some stuff").because).toBeTruthy();
  });
});
