import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { tailorPlanSchema, type TailorPlan } from './plan';
import { buildChanges, buildDocument } from './apply';
import { estimateLines } from '../render/model';
import { getTemplate } from '../render/templates';
import { fitToTarget } from './fit';

/**
 * The trim that replaced asking nicely.
 *
 * The prompt carried a length budget for as long as tailoring existed, and the
 * model never reliably honoured it: three runs of one profile against one
 * posting gave fifteen bullets over two pages, ten over two, and twenty-five
 * over three — the last of them told "roughly 6 bullets, at most 3 projects".
 */

const bullets = (n: number, p: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${p}${i}`,
    text: `Owned a specific and checkable piece of work, number ${i}, that took real effort to do.`,
  }));

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: 'now',
  updatedAt: 'now',
  basics: { name: 'Tristan Heilman', summary: 'Mobile developer who owns more than the app. '.repeat(12) },
  work: [
    { id: 'wrk_new', name: 'Formedics', position: 'Native App Developer', startDate: '10/2025', bullets: bullets(12, 'a') },
    { id: 'wrk_old', name: 'Wridz', position: 'Lead Mobile Developer', startDate: '05/2022', endDate: '09/2025', bullets: bullets(10, 'b') },
  ],
  projects: Array.from({ length: 6 }, (_, i) => ({
    id: `prj_${i}`,
    name: `project-${i}`,
    bullets: bullets(5, `p${i}`),
  })),
  skills: Array.from({ length: 5 }, (_, i) => ({
    id: `skl_${i}`,
    name: `Group ${i}`,
    keywords: ['Alpha', 'Beta', 'Gamma', 'Delta'],
  })),
});

/** A plan that keeps everything — what an over-generous model returns. */
const keepAll = (): TailorPlan =>
  tailorPlanSchema.parse({
    summary: { text: '', rationale: '' },
    work: profile.work.map((w, i) => ({
      id: w.id,
      include: true,
      order: i,
      bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
    })),
    projects: profile.projects.map((p, i) => ({
      id: p.id,
      include: true,
      order: i,
      bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
    })),
    skills: profile.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
  });

const pages = (plan: TailorPlan, templateId = 'classic') => {
  const perPage = 50;
  void templateId;
  return Math.ceil(estimateLines(buildDocument(profile, plan, buildChanges(profile, plan))) / perPage);
};

describe('trimming a plan to the page target', () => {
  it('gets an over-generous plan onto one page', () => {
    // The plan the model actually returns: everything included.
    expect(pages(keepAll())).toBeGreaterThan(1);

    const { plan, fits } = fitToTarget(profile, keepAll(), 1);
    expect(fits).toBe(true);
    expect(pages(plan)).toBe(1);
  });

  it('leaves a plan that already fits completely alone', () => {
    // Everything excluded explicitly, not merely left out. An entry the plan
    // does not mention is *kept* by `buildDocument` — omission is not a drop —
    // so a sparse plan describes a full document, not an empty one.
    const small = tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: profile.work.map((w, i) => ({
        id: w.id,
        include: i === 0,
        order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: i === 0 && j === 0, order: j })),
      })),
      projects: profile.projects.map((p, i) => ({
        id: p.id,
        include: false,
        order: i,
        bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
      skills: profile.skills.map((sk, i) => ({ id: sk.id, include: true, order: i, keywords: sk.keywords })),
    });
    const { plan, dropped, fits } = fitToTarget(profile, small, 1);

    expect(fits).toBe(true);
    expect(dropped).toEqual([]);
    expect(plan).toEqual(small);
  });

  it('does not mutate the plan it was given', () => {
    const original = keepAll();
    const snapshot = JSON.stringify(original);
    fitToTarget(profile, original, 1);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('takes project bullets before role bullets', () => {
    const { plan } = fitToTarget(profile, keepAll(), 1);
    const kept = (es: typeof plan.work) =>
      es.filter((e) => e.include).reduce((n, e) => n + e.bullets.filter((b) => b.include).length, 0);

    const roleBullets = kept(plan.work);
    const projectBullets = kept(plan.projects);
    // Projects bear the cuts, so proportionally far more role content survives.
    expect(roleBullets).toBeGreaterThan(projectBullets);
  });

  it('never drops a role', () => {
    // An unexplained gap in a timeline costs more than a long resume.
    const { plan } = fitToTarget(profile, keepAll(), 1);
    expect(plan.work.every((w) => w.include)).toBe(true);
  });

  it('leaves every role with something under it', () => {
    const { plan } = fitToTarget(profile, keepAll(), 1);
    for (const w of plan.work) {
      expect(w.bullets.filter((b) => b.include).length, w.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('drops a project outright rather than leaving a one-line stub', () => {
    const { plan, droppedEntries } = fitToTarget(profile, keepAll(), 1);
    const stubs = plan.projects.filter((p) => p.include && p.bullets.filter((b) => b.include).length === 1);

    expect(stubs).toEqual([]);
    expect(droppedEntries.length).toBeGreaterThan(0);
  });

  it('reports what it removed, so the review can show it', () => {
    const { dropped } = fitToTarget(profile, keepAll(), 1);
    expect(dropped.length).toBeGreaterThan(0);
    expect(new Set(dropped).size).toBe(dropped.length);
  });

  it('keeps more on a two-page target than a one-page one', () => {
    const one = fitToTarget(profile, keepAll(), 1);
    const two = fitToTarget(profile, keepAll(), 2);
    expect(two.dropped.length).toBeLessThan(one.dropped.length);
  });

  it('uses the template when told which one', () => {
    // Compact fits more lines, so it should have to cut less.
    const classic = fitToTarget(profile, keepAll(), 1, getTemplate('classic'));
    const compact = fitToTarget(profile, keepAll(), 1, getTemplate('compact'));
    expect(compact.dropped.length).toBeLessThan(classic.dropped.length);
  });

  it('gives up rather than looping when nothing more may be cut', () => {
    // One role, one bullet, and an enormous summary: the summary alone
    // overflows and there is nothing left the rules permit taking.
    const stubborn = profileSchema.parse({
      ...profile,
      basics: { name: 'T', summary: 'x '.repeat(4000) },
      projects: [],
      work: [{ id: 'wrk_new', name: 'A', position: 'Dev', startDate: '01/2020', bullets: bullets(1, 'a') }],
    });
    const plan = tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: [{ id: 'wrk_new', include: true, order: 0, bullets: [{ bulletId: 'a0', include: true, order: 0 }] }],
      projects: [],
      skills: [],
    });

    const { fits, plan: out } = fitToTarget(stubborn, plan, 1);
    expect(fits).toBe(false);
    expect(out.work[0]!.bullets.filter((b) => b.include).length).toBe(1);
  });
});

describe('headroom against the estimate being wrong', () => {
  /**
   * `estimateLines` measured a real tailored resume at exactly one page. The
   * rendered PDF was two — page two carrying the education entry alone, seventy
   * characters of it. The estimate charges a flat two lines per section and per
   * entry and does not model leading, rules, or a heading refusing to be
   * stranded.
   */
  it('leaves room, rather than filling the page to the last line', () => {
    const { plan } = fitToTarget(profile, keepAll(), 1);
    const lines = estimateLines(buildDocument(profile, plan, buildChanges(profile, plan)));

    expect(lines).toBeLessThanOrEqual(50 - 5);
  });

  it('still fills most of the page', () => {
    // Headroom is not an excuse to produce a half-empty resume.
    const { plan } = fitToTarget(profile, keepAll(), 1);
    const lines = estimateLines(buildDocument(profile, plan, buildChanges(profile, plan)));

    expect(lines).toBeGreaterThan(28);
  });
});
