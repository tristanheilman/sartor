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
    expect(prompt(8, 6)).toMatch(/need to cut/i);
  });

  it('still asks for cuts when the work alone overflows', () => {
    expect(prompt(80, 0)).toMatch(/need to cut/i);
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

describe('what has to give when a page is genuinely full', () => {
  /**
   * A real profile: three roles, six projects, six skill groups, a long
   * summary. Seven entry headings and the skills block cost about forty-four
   * lines before a single bullet, so a one-page target left room for six —
   * which is not a resume, it is a business card.
   *
   * Squeezing bullets was the wrong lever. Nobody lists six side projects on a
   * one-pager; they list the two or three that fit the job. Roles are
   * different — dropping one leaves an unexplained gap in a timeline, which
   * costs far more than it saves.
   */
  const real = (projects: number): Profile =>
    profileSchema.parse({
      id: 'prf_1',
      createdAt: 'now',
      updatedAt: 'now',
      basics: {
        name: 'Tristan Heilman',
        summary: 'Mobile developer who owns more than the app. '.repeat(20),
      },
      work: Array.from({ length: 3 }, (_, i) => ({
        id: `wrk_${i}`,
        name: `Employer ${i}`,
        position: 'Developer',
        startDate: '01/2020',
        bullets: bullets(10, `w${i}`),
      })),
      projects: Array.from({ length: projects }, (_, i) => ({
        id: `prj_${i}`,
        name: `project-${i}`,
        bullets: bullets(5, `p${i}`),
      })),
      skills: Array.from({ length: 6 }, (_, i) => ({
        id: `skl_${i}`,
        name: `Group ${i}`,
        keywords: ['One', 'Two', 'Three', 'Four'],
      })),
    });

  const p1 = () => buildTailorUserPrompt(real(6), jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 1 });

  it('tells the model to keep only a few projects on one page', () => {
    expect(p1()).toMatch(/project/i);
    expect(p1()).toMatch(/include:\s*false|drop/i);
  });

  it('protects roles from being dropped', () => {
    // An employment gap a reader cannot explain is worse than a long resume.
    expect(p1()).toMatch(/every role|all .*roles|not .*roles/i);
  });

  it('leaves a workable number of bullets rather than collapsing to the floor', () => {
    // With projects pruned the overhead falls and the budget recovers off its
    // minimum — six bullets across three roles was not a resume.
    const budget = Number(p1().match(/roughly (\d+)/)![1]);
    expect(budget).toBeGreaterThan(6);
  });

  it('asks for fewer projects on one page than on two', () => {
    // Eight projects, so both targets have something to prune.
    const cap = (t: 1 | 2) =>
      Number(
        buildTailorUserPrompt(real(8), jd, { ...DEFAULT_CONSTRAINTS, pageTarget: t }).match(
          /at most (\d+) project/,
        )![1],
      );
    expect(cap(1)).toBeLessThan(cap(2));
  });

  it('says nothing about pruning projects when there are few enough already', () => {
    expect(buildTailorUserPrompt(real(2), jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 1 })).not.toMatch(
      /at most \d+ project/,
    );
  });
});

describe('what the summary is for', () => {
  /**
   * A tailored resume came back with a six-line summary narrating the Auth0
   * migration, a 2.8-million-user anonymization, the Jest suite and the
   * Fastlane pipelines — and those same facts cut from the bullets underneath
   * to make room for it.
   *
   * That is backwards twice over. A bullet is scannable and sits under the job
   * where the work happened; prose at the top is neither, and the reader has to
   * guess which employer each clause belongs to. And the summary cost about a
   * hundred and sixteen points — four bullets — to say what the bullets were
   * being cut to fit.
   */
  const p = (): Profile =>
    profileSchema.parse({
      id: 'prf_1',
      createdAt: 'now',
      updatedAt: 'now',
      basics: { name: 'Tristan Heilman', summary: 'Mobile developer.' },
      work: [{ id: 'wrk_1', name: 'Formedics', position: 'Dev', startDate: '10/2025', bullets: bullets(12, 'w') }],
      projects: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `p-${i}`, bullets: bullets(3, `pb${i}`) })),
    });

  const onePage = () => buildTailorUserPrompt(p(), jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 1 });

  it('asks for a short summary when the target is one page', () => {
    expect(onePage()).toMatch(/two sentences|2 sentences|at most two/i);
  });

  it('tells it not to repeat what the bullets already say', () => {
    expect(onePage()).toMatch(/repeat|duplicat|already/i);
  });

  it('says where a fact belongs', () => {
    // The point of the fix: a fact about a job goes under the job.
    expect(onePage()).toMatch(/bullet under|belongs under|under the role|under that role/i);
  });

  it('is more relaxed about length on two pages', () => {
    const two = buildTailorUserPrompt(p(), jd, { ...DEFAULT_CONSTRAINTS, pageTarget: 2 });
    expect(two).not.toBe(onePage());
  });
});
