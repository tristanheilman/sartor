import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { fromPaste } from '../jd/normalize';
import { buildTailorUserPrompt, DEFAULT_CONSTRAINTS } from './prompt';

/**
 * The length budget, which decided nothing about half the document.
 *
 * `budgetHint` counted `profile.work` and stopped there. Projects render on the
 * same page and take the same room, so a profile with six projects was told it
 * had "14 experience bullets, which fits within 1 page" while carrying thirty
 * more lines the budget never saw. The tailored resume came out at two pages
 * against a one-page target — the exact thing the whole grand-profile idea
 * exists to avoid.
 */

const bullets = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    text: `Did a specific and worthwhile thing number ${i} that a reader can check.`,
  }));

const profile = (work: number, projects: number): Profile =>
  profileSchema.parse({
    id: 'prf_1',
    createdAt: 'now',
    updatedAt: 'now',
    basics: { name: 'Tristan Heilman', summary: 'Mobile developer.' },
    work: [
      { id: 'wrk_1', name: 'Formedics', position: 'Native App Developer', startDate: '10/2025', bullets: bullets(work, 'w') },
    ],
    projects: Array.from({ length: projects }, (_, i) => ({
      id: `prj_${i}`,
      name: `project-${i}`,
      bullets: bullets(5, `p${i}`),
    })),
  });

const jd = fromPaste('Senior Mobile Engineer. React Native, Swift, Kotlin, Auth0, Docker.');
const prompt = (work: number, projects: number, pageTarget: 1 | 2 = 1) =>
  buildTailorUserPrompt(profile(work, projects), jd, { ...DEFAULT_CONSTRAINTS, pageTarget });

describe('the length budget', () => {
  it('counts project bullets, which take the same room on the page', () => {
    // 8 work bullets is under the one-page budget on its own. Six projects at
    // five bullets each is thirty more lines competing for the same page.
    const p = prompt(8, 6);
    expect(p).toMatch(/38/);
  });

  it('tells a profile that genuinely fits that it does not need to cut', () => {
    expect(prompt(6, 0)).toMatch(/do not need to cut aggressively/);
  });

  it('asks for cuts once the two together overflow', () => {
    // The defect: this profile was told it fitted, because only the 8 counted.
    expect(prompt(8, 6)).toMatch(/need to drop/i);
  });

  it('still asks for cuts when the work alone overflows', () => {
    expect(prompt(80, 0)).toMatch(/need to drop/i);
  });

  it('says bullets may be cut from projects as well as roles', () => {
    // Otherwise the model reads "drop bullets, not roles" as licence to take
    // every cut out of employment history and leave the projects untouched.
    expect(prompt(8, 6)).toMatch(/project/i);
  });

  it('gives a two-page target a larger budget', () => {
    const budget = (p: string) => Number(p.match(/roughly (\d+)/)![1]);
    expect(budget(prompt(20, 4, 2))).toBeGreaterThan(budget(prompt(20, 4, 1)));
  });
});

describe('the budget accounts for what else is on the page', () => {
  /**
   * A flat "roughly 14 bullets" ignored everything competing for the same
   * space. Measured on a real profile, 15 kept bullets still came to two pages,
   * because a 900-character summary, five skill groups, three role headings,
   * project headings and an education entry cost about thirty-five lines before
   * any bullet is printed.
   */
  const withOverhead = (over: Partial<Record<string, unknown>>): Profile =>
    profileSchema.parse({
      id: 'prf_1',
      createdAt: 'now',
      updatedAt: 'now',
      basics: { name: 'Tristan Heilman', summary: 'Mobile developer.' },
      work: [{ id: 'wrk_1', name: 'A', position: 'Dev', startDate: '01/2020', bullets: bullets(30, 'w') }],
      ...over,
    });

  const budgetIn = (p: Profile) => {
    const m = buildTailorUserPrompt(p, jd, DEFAULT_CONSTRAINTS).match(/roughly (\d+)/);
    return m ? Number(m[1]) : null;
  };

  it('leaves less room for bullets when the summary is long', () => {
    const short = budgetIn(withOverhead({}))!;
    const long = budgetIn(
      withOverhead({
        basics: { name: 'T', summary: 'A very deliberate sentence about the work. '.repeat(20) },
      }),
    )!;
    expect(long).toBeLessThan(short);
  });

  it('leaves less room when there are many skill groups', () => {
    const few = budgetIn(withOverhead({}))!;
    const many = budgetIn(
      withOverhead({
        skills: Array.from({ length: 6 }, (_, i) => ({
          id: `s${i}`,
          name: `Group ${i}`,
          keywords: ['One', 'Two', 'Three'],
        })),
      }),
    )!;
    expect(many).toBeLessThan(few);
  });

  it('leaves less room when there are project entries to head', () => {
    const none = budgetIn(withOverhead({}))!;
    const some = budgetIn(
      withOverhead({
        projects: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `p-${i}`, bullets: bullets(3, `pb${i}`) })),
      }),
    )!;
    expect(some).toBeLessThan(none);
  });

  it('gives two pages roughly twice the room of one', () => {
    const p = withOverhead({});
    const one = Number(buildTailorUserPrompt(p, jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 1 }).match(/roughly (\d+)/)![1]);
    const two = Number(buildTailorUserPrompt(p, jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 2 }).match(/roughly (\d+)/)![1]);
    expect(two).toBeGreaterThan(one * 1.5);
  });

  it('never asks for so few that the resume is empty', () => {
    // A pathological profile — enormous summary, many groups — must still leave
    // room to say something.
    const crowded = withOverhead({
      basics: { name: 'T', summary: 'x'.repeat(4000) },
      skills: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `G${i}`, keywords: ['a'] })),
      projects: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, bullets: bullets(3, `q${i}`) })),
    });
    expect(budgetIn(crowded)!).toBeGreaterThanOrEqual(6);
  });
});
