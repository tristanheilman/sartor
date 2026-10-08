import { describe, it, expect } from 'vitest';
import { ingestResume, INGEST_JSON_SCHEMA, INGEST_SYSTEM_PROMPT } from './ingest';
import { keepOneWording, resolveDuplicates } from './duplicates';
import type { LLMProvider } from '../provider';

/**
 * The same fact, imported twice.
 *
 * A full-profile resume carried three bullets for one library, two of them the
 * same claim: "Built a public React Native library to bridge iOS ObjectCapture
 * and PhotogrammatrySession views…" — misspelled — and "Published a React
 * Native library bridging Apple's Object Capture and PhotogrammetrySession…",
 * which is spelled right and says more. Tailoring kept the first and dropped
 * the second, and a second library got two bullets that said one thing.
 *
 * Word overlap cannot find these. Against that profile the misspelled pair
 * scores 0.18 and the other 0.26, while two unrelated bullets from one job
 * score 0.29 — there is no threshold. So the model that reads the resume flags
 * them, as a suggestion, and the person decides which wording is the bullet.
 * The other is kept as its variant, word for word. Nothing is rewritten.
 */

const raw = (projects: Array<{ name: string; bullets: Array<{ text: string; restates: number }> }>) => ({
  basics: { name: 'Dana Reyes', label: '', email: 'd@example.com', phone: '', url: '', summary: '', city: '', region: '', profiles: [] },
  work: [],
  education: [],
  projects: projects.map((p) => ({ description: '', url: '', startDate: '', endDate: '', ...p })),
  skills: [],
  certificates: [],
  awards: [],
});

const providerReturning = (json: unknown): LLMProvider =>
  ({
    info: { id: 'fake', label: 'Fake' },
    complete: async () => ({ json, text: JSON.stringify(json), model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } }),
  }) as unknown as LLMProvider;

const ingest = (json: unknown) => ingestResume('resume text', providerReturning(json), { apiKey: 'k', model: 'm' });

const CAPTURE = [
  { text: 'Built a public React Native library to bridge iOS ObjectCapture and PhotogrammatrySession views and classes to the javascript scope', restates: 0 },
  { text: 'Published and maintaining a public NPM package', restates: 0 },
  { text: "Published a React Native library bridging Apple's Object Capture and PhotogrammetrySession into JavaScript, enabling LiDAR scanning of real objects.", restates: 1 },
];

describe('flagging bullets that restate one another', () => {
  it('asks the model to say which earlier bullet a bullet restates', () => {
    const bullet = INGEST_JSON_SCHEMA.properties.projects.items.properties.bullets.items;
    expect(bullet.required).toContain('restates');
    expect(INGEST_SYSTEM_PROMPT).toMatch(/restates/);
  });

  it('reports the pair the model flagged, by bullet id', async () => {
    const { profile, duplicates } = await ingest(raw([{ name: 'react-native-object-capture', bullets: CAPTURE }]));
    const ids = profile.projects[0]!.bullets.map((b) => b.id);

    expect(duplicates).toEqual([
      { entryId: profile.projects[0]!.id, entryName: 'react-native-object-capture', bulletIds: [ids[0], ids[2]] },
    ]);
  });

  it('leaves the profile exactly as transcribed', async () => {
    // A flag is a question for the person, not a decision. Both bullets stay.
    const { profile } = await ingest(raw([{ name: 'react-native-object-capture', bullets: CAPTURE }]));
    expect(profile.projects[0]!.bullets.map((b) => b.text)).toEqual(CAPTURE.map((b) => b.text));
  });

  it('ignores a flag that does not point at an earlier bullet of the same entry', async () => {
    const { duplicates } = await ingest(
      raw([
        {
          name: 'p',
          bullets: [
            { text: 'Points at itself, which is nothing.', restates: 1 },
            { text: 'Points forward, at a bullet not yet seen.', restates: 3 },
            { text: 'Points past the end of the list.', restates: 9 },
            { text: 'Points at a negative position.', restates: -1 },
          ],
        },
      ]),
    );
    expect(duplicates).toEqual([]);
  });

  it('counts positions as the model saw them, before blank bullets are dropped', async () => {
    const { profile, duplicates } = await ingest(
      raw([
        {
          name: 'p',
          bullets: [
            { text: '   ', restates: 0 },
            { text: 'Shipped the Auth0 cutover behind a kill switch.', restates: 0 },
            { text: 'Cut over to Auth0 with a remote-config kill switch.', restates: 2 },
          ],
        },
      ]),
    );
    const ids = profile.projects[0]!.bullets.map((b) => b.id);
    expect(duplicates[0]!.bulletIds).toEqual([ids[0], ids[1]]);
  });
});

describe('keeping one wording', () => {
  const setup = async () => {
    const { profile, duplicates } = await ingest(raw([{ name: 'react-native-object-capture', bullets: CAPTURE }]));
    const [first, second] = duplicates[0]!.bulletIds;
    return { profile, first, second };
  };

  it('keeps the chosen wording as the bullet and the other as its variant, word for word', async () => {
    const { profile, first, second } = await setup();
    const next = keepOneWording(profile, second, first);
    const bullets = next.projects[0]!.bullets;

    expect(bullets.map((b) => b.text)).toEqual([CAPTURE[1]!.text, CAPTURE[2]!.text]);
    expect(bullets[1]!.variants.map((v) => v.text)).toEqual([CAPTURE[0]!.text]);
    expect(bullets[1]!.variants[0]!.source).toBe('original');
  });

  it('keeps the bullet where the chosen one was', async () => {
    const { profile, first, second } = await setup();
    const next = keepOneWording(profile, first, second);

    expect(next.projects[0]!.bullets.map((b) => b.id)).toEqual([first, profile.projects[0]!.bullets[1]!.id]);
    expect(next.projects[0]!.bullets[0]!.variants.map((v) => v.text)).toEqual([CAPTURE[2]!.text]);
  });

  it('carries over variants the merged bullet already had', async () => {
    const { profile, first, second } = await setup();
    const withVariant = structuredClone(profile);
    withVariant.projects[0]!.bullets[0]!.variants.push({
      id: 'var_x', text: 'An older wording of the same thing.', source: 'user', createdAt: 'now',
    });
    const next = keepOneWording(withVariant, second, first);

    expect(next.projects[0]!.bullets[1]!.variants.map((v) => v.text)).toEqual([
      CAPTURE[0]!.text,
      'An older wording of the same thing.',
    ]);
  });

  it('does not touch the profile it was given', async () => {
    const { profile, first, second } = await setup();
    const snapshot = JSON.stringify(profile);
    keepOneWording(profile, second, first);
    expect(JSON.stringify(profile)).toBe(snapshot);
  });

  it('refuses two bullets from different entries', async () => {
    const { profile } = await ingest(
      raw([
        { name: 'a', bullets: [{ text: 'One thing that happened at a.', restates: 0 }] },
        { name: 'b', bullets: [{ text: 'Another thing that happened at b.', restates: 0 }] },
      ]),
    );
    const a = profile.projects[0]!.bullets[0]!.id;
    const b = profile.projects[1]!.bullets[0]!.id;
    expect(keepOneWording(profile, a, b)).toBe(profile);
  });
});

describe('settling flagged pairs from a list, for a run with nobody to ask', () => {
  /**
   * The audit flags suspected repeats but a scripted run had no way to answer
   * them, so it went on using the misspelled "PhotogrammatrySession" bullet.
   * Bullet ids are minted afresh on every import, so the list may name a
   * wording by the start of its text as well as by id.
   */
  const setup = async () => {
    const { profile, duplicates } = await ingest(raw([{ name: 'react-native-object-capture', bullets: CAPTURE }]));
    return { profile, duplicates };
  };

  it('keeps the wording a list names by the start of its text', async () => {
    const { profile, duplicates } = await setup();
    const { profile: next, resolved, unresolved } = resolveDuplicates(profile, duplicates, ['Published a React Native library bridging']);

    expect(next.projects[0]!.bullets.map((b) => b.text)).toEqual([CAPTURE[1]!.text, CAPTURE[2]!.text]);
    expect(next.projects[0]!.bullets[1]!.variants.map((v) => v.text)).toEqual([CAPTURE[0]!.text]);
    expect(resolved).toHaveLength(1);
    expect(unresolved).toEqual([]);
  });

  it('keeps the wording a list names by id', async () => {
    const { profile, duplicates } = await setup();
    const keep = duplicates[0]!.bulletIds[0];
    const { profile: next } = resolveDuplicates(profile, duplicates, [keep]);
    expect(next.projects[0]!.bullets[0]!.id).toBe(keep);
    expect(next.projects[0]!.bullets).toHaveLength(2);
  });

  it('leaves a pair alone when the list names neither, or both', async () => {
    const { profile, duplicates } = await setup();
    const neither = resolveDuplicates(profile, duplicates, ['Something else entirely']);
    const both = resolveDuplicates(profile, duplicates, ['Built a public', 'Published a React Native']);

    expect(neither.profile).toBe(profile);
    expect(neither.unresolved).toEqual(duplicates);
    expect(both.profile).toBe(profile);
    expect(both.unresolved).toEqual(duplicates);
  });
});
