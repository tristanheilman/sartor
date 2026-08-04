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
    expect(prompt(30, 0)).toMatch(/need to drop/i);
  });

  it('says bullets may be cut from projects as well as roles', () => {
    // Otherwise the model reads "drop bullets, not roles" as licence to take
    // every cut out of employment history and leave the projects untouched.
    expect(prompt(8, 6)).toMatch(/project/i);
  });

  it('gives a two-page target a larger budget', () => {
    const one = prompt(20, 4, 1);
    const two = prompt(20, 4, 2);
    expect(one).not.toBe(two);
    expect(two).toMatch(/26/);
  });
});
