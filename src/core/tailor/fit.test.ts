import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { tailorPlanSchema, type TailorPlan } from './plan';
import { buildChanges, buildDocument } from './apply';
import { estimateHeight, pageHeight } from '../render/model';
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

const CLASSIC_METRICS = {
  baseSize: 10, lineHeight: 1.4, pageMargin: 42,
  sectionGap: 12, entryGap: 9, bulletGap: 3, headingRule: true,
};

const pages = (plan: TailorPlan) =>
  Math.ceil(
    estimateHeight(buildDocument(profile, plan, buildChanges(profile, plan)), CLASSIC_METRICS) /
      pageHeight(CLASSIC_METRICS),
  );

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
    const { dropped, fits } = fitToTarget(profile, small, 1);

    expect(fits).toBe(true);
    // Nothing is *cut* from a plan that fits. Bullets may be added back — a
    // page with room to spare should use it — which is asserted separately.
    expect(dropped).toEqual([]);
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
  const CLASSIC = {
    baseSize: 10, lineHeight: 1.4, pageMargin: 42,
    sectionGap: 12, entryGap: 9, bulletGap: 3, headingRule: true,
  };
  const heightOf = (plan: TailorPlan) =>
    estimateHeight(buildDocument(profile, plan, buildChanges(profile, plan)), CLASSIC);

  it('leaves room, rather than filling the page to the last line', () => {
    const { plan } = fitToTarget(profile, keepAll(), 1);
    expect(heightOf(plan)).toBeLessThanOrEqual(pageHeight(CLASSIC));
  });

  it('still fills most of the page', () => {
    // Headroom is not an excuse to produce a half-empty resume.
    const { plan } = fitToTarget(profile, keepAll(), 1);
    expect(heightOf(plan)).toBeGreaterThan(pageHeight(CLASSIC) * 0.55);
  });
});

describe('which project survives the cut', () => {
  /**
   * The first version sacrificed projects wholesale — fattest first, all of
   * them, before touching a single role bullet. On a posting whose
   * nice-to-haves included "published open-source React Native libraries",
   * that produced a resume with no projects section at all, while the summary
   * still claimed the person publishes React Native libraries.
   *
   * The fix is not "keep projects". It is to spend the page on what the posting
   * asked for: cut the least relevant project first and protect the most
   * relevant one, so the library that answers the posting outlives the golf
   * app that does not.
   */
  const jd = `Senior Mobile Engineer. React Native, Swift and Kotlin native modules.
     Nice to have: published open-source React Native libraries.`;

  const withProjects: Profile = profileSchema.parse({
    ...profile,
    projects: [
      { id: 'prj_golf', name: 'diy-swing-analysis', bullets: [
        { id: 'g0', text: 'Built a golf swing analysis desktop app using pose estimation and OpenCV.' },
        { id: 'g1', text: 'Detected swing phase boundaries from the wrist trajectory across frames.' },
        { id: 'g2', text: 'Wired a coaching service that returns structured feedback and practice drills.' },
      ] },
      { id: 'prj_island', name: 'react-native-island', bullets: [
        { id: 'i0', text: 'Built and maintain an open-source React Native library exposing iOS Live Activities and Android notifications.' },
        { id: 'i1', text: 'Bridged native iOS and Android features into React Native for other developers to consume.' },
        { id: 'i2', text: 'Published the library and continue to maintain it.' },
      ] },
      { id: 'prj_recipes', name: 'recipe-box', bullets: [
        { id: 'r0', text: 'Built a small recipe organiser for personal use over a weekend.' },
        { id: 'r1', text: 'Stored everything in a local file with no server involved.' },
      ] },
    ],
  });

  const planFor = (p: Profile): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: p.work.map((w, i) => ({
        id: w.id, include: true, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
      })),
      projects: p.projects.map((pr, i) => ({
        id: pr.id, include: true, order: i,
        bullets: pr.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
      })),
      skills: p.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  const fit = (p = withProjects) =>
    fitToTarget(p, planFor(p), 1, undefined, jd);

  it('keeps the project the posting actually asked about', () => {
    const { plan } = fit();
    const island = plan.projects.find((p) => p.id === 'prj_island')!;

    expect(island.include).toBe(true);
    expect(island.bullets.filter((b) => b.include).length).toBeGreaterThan(0);
  });

  it('drops the least relevant project first', () => {
    const { droppedEntries } = fit();
    expect(droppedEntries).toContain('prj_recipes');
    expect(droppedEntries).not.toContain('prj_island');
  });

  it('ranks a partly-relevant project above an unrelated one', () => {
    // Two projects that both mention the posting's subject to different
    // degrees. Ordering between two that match nothing at all is arbitrary and
    // not worth asserting; ordering between these is the whole point.
    const p: Profile = profileSchema.parse({
      ...profile,
      projects: [
        { id: 'prj_recipes', name: 'recipe-box', bullets: [
          { id: 'r0', text: 'A weekend recipe organiser storing everything in a local file.' },
          { id: 'r1', text: 'No server, no accounts, nothing to run.' },
          { id: 'r2', text: 'Written for personal use and never published.' },
        ] },
        { id: 'prj_native', name: 'swift-bridge-kit', bullets: [
          { id: 'n0', text: 'Swift and Kotlin native modules exposed to React Native.' },
          { id: 'n1', text: 'Published as an open-source React Native library.' },
          { id: 'n2', text: 'Used by other developers building mobile applications.' },
        ] },
      ],
    });

    const { droppedEntries, plan } = fitToTarget(p, planFor(p), 1, undefined, jd);
    const native = plan.projects.find((x) => x.id === 'prj_native')!;

    expect(droppedEntries).toContain('prj_recipes');
    expect(native.include).toBe(true);
  });

  it('still never drops a role', () => {
    const { plan } = fit();
    expect(plan.work.every((w) => w.include)).toBe(true);
  });

  it('still fits the page', () => {
    const { fits } = fit();
    expect(fits).toBe(true);
  });

  it('falls back to size order when there is no posting to rank against', () => {
    // Without a JD there is nothing to be relevant *to*, so the old behaviour
    // is the right one rather than an arbitrary ranking.
    const { plan } = fitToTarget(withProjects, planFor(withProjects), 1);
    expect(plan.work.every((w) => w.include)).toBe(true);
  });
});

describe('entries left with nothing under them', () => {
  /**
   * A real run returned a plan with `Revento` included and every one of its
   * bullets excluded. The trim never looked at it — it only considers entries
   * that still have bullets to take — so the resume shipped with a PROJECTS
   * section containing a heading, a date range and nothing else.
   *
   * The "no empty sections" check passes, because the section is not empty: it
   * has an entry. The entry is.
   */
  const hollow = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: profile.work.map((w, i) => ({
        id: w.id, include: true, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: j < 2, order: j })),
      })),
      projects: profile.projects.map((p, i) => ({
        id: p.id, include: true, order: i,
        // Included, with nothing to show — exactly what the model returned.
        bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
      skills: profile.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  it('drops a project the plan kept but emptied', () => {
    const { plan } = fitToTarget(profile, hollow(), 1);
    const hollowProjects = plan.projects.filter(
      (p) => p.include && p.bullets.filter((b) => b.include).length === 0,
    );
    expect(hollowProjects).toEqual([]);
  });

  it('reports those drops like any other', () => {
    const { droppedEntries } = fitToTarget(profile, hollow(), 1);
    expect(droppedEntries.length).toBeGreaterThan(0);
  });

  it('leaves an emptied role alone, because dates carry the timeline', () => {
    // A role with no bullets still says the person was employed, and removing
    // it opens a gap. A project with no bullets says nothing at all.
    const rolesEmptied = tailorPlanSchema.parse({
      ...hollow(),
      work: profile.work.map((w, i) => ({
        id: w.id, include: true, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
    });
    const { plan } = fitToTarget(profile, rolesEmptied, 1);
    expect(plan.work.every((w) => w.include)).toBe(true);
  });
});

describe('a project the model dropped that the posting asked for', () => {
  /**
   * The ranking only orders what the plan kept. Across runs of one profile
   * against one posting, the model sometimes included `react-native-island` and
   * sometimes did not — and when it did not, a posting whose nice-to-haves read
   * "published open-source React Native libraries" produced a resume with no
   * projects section, from a profile containing exactly that library.
   *
   * So one project may be put back: the best match, only when it is a real
   * match, and only if the page can hold it. Everything else the model dropped
   * stays dropped — this is a floor under relevance, not a second opinion on
   * the model's judgement.
   */
  const jd = `Senior Mobile Engineer. React Native, Swift and Kotlin native modules.
     Nice to have: published open-source React Native libraries.`;

  const p: Profile = profileSchema.parse({
    ...profile,
    work: [profile.work[0]],
    projects: [
      { id: 'prj_island', name: 'react-native-island', bullets: [
        { id: 'i0', text: 'Built and maintain an open-source React Native library exposing iOS Live Activities and Android notifications.' },
        { id: 'i1', text: 'Bridged native iOS and Android features into React Native for other developers.' },
      ] },
      { id: 'prj_recipes', name: 'recipe-box', bullets: [
        { id: 'r0', text: 'A weekend recipe organiser storing everything in a local file.' },
      ] },
    ],
  });

  /** What the model returned: every project switched off. */
  const noProjects = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: p.work.map((w, i) => ({
        id: w.id, include: true, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: j < 3, order: j })),
      })),
      projects: p.projects.map((pr, i) => ({
        id: pr.id, include: false, order: i,
        bullets: pr.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
      skills: p.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  it('puts the matching project back', () => {
    const { plan, reinstated } = fitToTarget(p, noProjects(), 1, undefined, jd);
    const island = plan.projects.find((x) => x.id === 'prj_island')!;

    expect(island.include).toBe(true);
    expect(island.bullets.filter((b) => b.include).length).toBeGreaterThan(0);
    expect(reinstated).toBe('prj_island');
  });

  it('puts back only the best one', () => {
    const { plan } = fitToTarget(p, noProjects(), 1, undefined, jd);
    expect(plan.projects.filter((x) => x.include).map((x) => x.id)).toEqual(['prj_island']);
  });

  it('leaves the model alone when nothing is a real match', () => {
    // A posting about something else entirely. The model dropped the projects
    // and it was right to.
    const unrelated = 'Senior Accountant. Reconciliations, ledgers, audit support, month-end close.';
    const { plan, reinstated } = fitToTarget(p, noProjects(), 1, undefined, unrelated);

    expect(reinstated).toBeNull();
    expect(plan.projects.every((x) => !x.include)).toBe(true);
  });

  it('puts the better one back even when a weaker project was kept', () => {
    // The real failure: the model kept `Revento` and dropped
    // `react-native-island`, so the projects section existed and the best match
    // was never considered. A section containing *a* project is not the same as
    // one containing the right project.
    const keptWrong = tailorPlanSchema.parse({
      ...noProjects(),
      projects: p.projects.map((pr, i) => ({
        id: pr.id, include: pr.id === 'prj_recipes', order: i,
        bullets: pr.bullets.map((b, j) => ({
          bulletId: b.id, include: pr.id === 'prj_recipes' && j === 0, order: j,
        })),
      })),
    });
    const { plan, reinstated } = fitToTarget(p, keptWrong, 1, undefined, jd);

    expect(reinstated).toBe('prj_island');
    expect(plan.projects.find((x) => x.id === 'prj_island')!.include).toBe(true);
  });

  it('leaves the model alone when it already kept the best one', () => {
    const keptBest = tailorPlanSchema.parse({
      ...noProjects(),
      projects: p.projects.map((pr, i) => ({
        id: pr.id, include: pr.id === 'prj_island', order: i,
        bullets: pr.bullets.map((b, j) => ({
          bulletId: b.id, include: pr.id === 'prj_island' && j === 0, order: j,
        })),
      })),
    });
    expect(fitToTarget(p, keptBest, 1, undefined, jd).reinstated).toBeNull();
  });

  it('does not put one back when there is no room', () => {
    // A summary that fills the page on its own. Skills can be trimmed and roles
    // reduced to a bullet each, and it still does not fit — so there is nothing
    // to reinstate into.
    const crowded = profileSchema.parse({ ...p, basics: { ...p.basics, summary: 'x '.repeat(4000) } });
    const { plan, fits } = fitToTarget(crowded, noProjects(), 1, undefined, jd);

    expect(plan.projects.every((x) => !x.include)).toBe(true);
    expect(fits).toBe(false);
  });

  it('reinstates nothing without a posting to judge against', () => {
    expect(fitToTarget(p, noProjects(), 1).reinstated).toBeNull();
  });
});

describe('skill groups as the compressible part of the page', () => {
  /**
   * With roles down to a bullet each, the page still overflowed and the
   * protected project was sacrificed — while six skill groups sat there taking
   * eleven lines, two of them naming nothing the posting had asked for.
   *
   * Skills are the cheapest thing on a resume to lose: a group the posting
   * never mentions is a list of words nobody reads. They are cut before a
   * project the posting explicitly asked for.
   */
  const jd = 'React Native, Swift, Kotlin. Published open-source React Native libraries.';

  const p: Profile = profileSchema.parse({
    ...profile,
    basics: { ...profile.basics, summary: 'Mobile developer who owns more than the app. '.repeat(14) },
    projects: [
      { id: 'prj_island', name: 'react-native-island', bullets: [
        { id: 'i0', text: 'Built and maintain an open-source React Native library exposing iOS Live Activities.' },
        { id: 'i1', text: 'Bridged native iOS and Android features into React Native.' },
      ] },
    ],
    skills: [
      { id: 'skl_lang', name: 'Languages', keywords: ['React Native', 'Swift', 'Kotlin'] },
      { id: 'skl_a', name: 'Office', keywords: ['Excel', 'Powerpoint', 'Word', 'Outlook', 'Sharepoint'] },
      { id: 'skl_b', name: 'Hobbies', keywords: ['Woodworking', 'Cycling', 'Baking', 'Photography', 'Chess'] },
      { id: 'skl_c', name: 'Languages Spoken', keywords: ['English', 'Spanish', 'German', 'Portuguese'] },
      { id: 'skl_d', name: 'Certifications', keywords: ['First Aid', 'Food Safety', 'Forklift', 'Scuba'] },
    ],
  });

  const plan = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: p.work.map((w, i) => ({
        id: w.id, include: true, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
      })),
      projects: p.projects.map((pr, i) => ({
        id: pr.id, include: true, order: i,
        bullets: pr.bullets.map((b, j) => ({ bulletId: b.id, include: true, order: j })),
      })),
      skills: p.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  it('drops skill groups the posting never mentions', () => {
    const { plan: out } = fitToTarget(p, plan(), 1, undefined, jd);
    const kept = out.skills.filter((s) => s.include).map((s) => s.id);

    expect(kept.length).toBeLessThan(5);
    expect(kept).toContain('skl_lang');
  });

  it('keeps the project the posting asked for', () => {
    const { plan: out } = fitToTarget(p, plan(), 1, undefined, jd);
    const island = out.projects.find((x) => x.id === 'prj_island')!;
    expect(island.include).toBe(true);
  });

  it('never strips skills down to nothing', () => {
    // A resume with no skills section reads as an omission, not as focus.
    const { plan: out } = fitToTarget(p, plan(), 1, undefined, jd);
    expect(out.skills.filter((s) => s.include).length).toBeGreaterThanOrEqual(2);
  });

  it('leaves skills alone when the page already fits', () => {
    const small = profileSchema.parse({ ...p, work: [p.work[0]], projects: [] });
    const { plan: out } = fitToTarget(small, plan(), 1, undefined, jd);
    expect(out.skills.filter((s) => s.include).length).toBe(5);
  });

  it('still trims skills without a posting, just in the profile’s own order', () => {
    // There is nothing to be relevant to, but not cutting skills at all means
    // taking the difference out of someone's employment history instead.
    const { plan: out } = fitToTarget(p, plan(), 1);
    const kept = out.skills.filter((s) => s.include);

    expect(kept.length).toBeLessThan(5);
    expect(kept.length).toBeGreaterThanOrEqual(2);
    // Trailing groups go first, so the earlier ones survive.
    expect(kept.map((s) => s.id)).toContain('skl_lang');
  });
});

describe('a role the model kept but emptied', () => {
  /**
   * CIMx rendered as a job title, an employer and a date range, with nothing
   * under it — the model included the entry and excluded every bullet. Hollow
   * projects were already dropped; roles were deliberately left alone, because
   * removing one opens a gap in a timeline.
   *
   * Both halves of that were right and the conclusion was wrong. The role
   * should stay *and* say something: a heading with no content under it reads
   * as padding, and the profile has bullets for it — the model simply chose
   * none of them.
   */
  const emptiedRole = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: profile.work.map((w, i) => ({
        id: w.id,
        include: true,
        order: i,
        // The oldest role emptied, exactly as the model returned it.
        bullets: w.bullets.map((b, j) => ({
          bulletId: b.id,
          include: i === 0 ? j < 2 : false,
          order: j,
        })),
      })),
      projects: profile.projects.map((p, i) => ({
        id: p.id, include: false, order: i,
        bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
      skills: profile.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  it('gives every kept role something to say', () => {
    const { plan } = fitToTarget(profile, emptiedRole(), 1);
    for (const w of plan.work.filter((x) => x.include)) {
      expect(w.bullets.filter((b) => b.include).length, w.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('takes the bullet the model ranked first', () => {
    const { plan } = fitToTarget(profile, emptiedRole(), 1);
    const restored = plan.work[1]!;
    const kept = restored.bullets.filter((b) => b.include).sort((a, b) => a.order - b.order);

    expect(kept[0]!.order).toBe(0);
  });

  it('still keeps the role, rather than dropping it to save the space', () => {
    const { plan } = fitToTarget(profile, emptiedRole(), 1);
    expect(plan.work.every((w) => w.include)).toBe(true);
  });

  it('still fits, having paid for it somewhere else', () => {
    expect(fitToTarget(profile, emptiedRole(), 1).fits).toBe(true);
  });

  it('leaves a role the model deliberately dropped alone', () => {
    // Excluding the entry is a decision. Emptying it is an oversight.
    const droppedRole = tailorPlanSchema.parse({
      ...emptiedRole(),
      work: profile.work.map((w, i) => ({
        id: w.id, include: i === 0, order: i,
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: i === 0 && j < 2, order: j })),
      })),
    });
    const { plan } = fitToTarget(profile, droppedRole, 1);

    expect(plan.work[1]!.include).toBe(false);
    expect(plan.work[1]!.bullets.every((b) => !b.include)).toBe(true);
  });
});

describe('filling the page rather than merely fitting it', () => {
  /**
   * The trim only ever removed. It cut until the document fitted and stopped,
   * so a budget the model undershot — or a cut that overshot — left a resume
   * with one bullet per role and a fifth of the page blank. Fitting a page and
   * using a page are not the same thing, and a sparse resume reads as though
   * there was nothing to say.
   *
   * Growing back is the symmetric operation, and it is the same kind of change:
   * bullets are switched on rather than off, they are the person's own, and the
   * review screen shows every one.
   */
  const sparse = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: profile.work.map((w, i) => ({
        id: w.id,
        include: true,
        order: i,
        // One bullet each, as an over-cautious plan returns.
        bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: j === 0, order: j })),
      })),
      projects: profile.projects.map((p, i) => ({
        id: p.id, include: false, order: i,
        bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
      skills: profile.skills.map((s, i) => ({ id: s.id, include: true, order: i, keywords: s.keywords })),
    });

  const kept = (plan: TailorPlan) =>
    plan.work.filter((w) => w.include).reduce((n, w) => n + w.bullets.filter((b) => b.include).length, 0);

  it('adds bullets back when the page has room', () => {
    const before = kept(sparse());
    const { plan, added } = fitToTarget(profile, sparse(), 1);

    expect(kept(plan)).toBeGreaterThan(before);
    expect(added.length).toBeGreaterThan(0);
  });

  it('still fits afterwards', () => {
    expect(fitToTarget(profile, sparse(), 1).fits).toBe(true);
  });

  it('fills most of the page', () => {
    const { plan } = fitToTarget(profile, sparse(), 1);
    const CLASSIC = {
      baseSize: 10, lineHeight: 1.4, pageMargin: 42,
      sectionGap: 12, entryGap: 9, bulletGap: 3, headingRule: true,
    };
    const used = estimateHeight(buildDocument(profile, plan, buildChanges(profile, plan)), CLASSIC);
    expect(used).toBeGreaterThan(pageHeight(CLASSIC) * 0.85);
  });

  it('spreads them rather than stacking one entry', () => {
    // Six bullets on the newest role and one on everything else is not a
    // fuller resume, it is a lopsided one.
    const { plan } = fitToTarget(profile, sparse(), 1);
    const counts = plan.work.filter((w) => w.include).map((w) => w.bullets.filter((b) => b.include).length);

    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });

  it('takes the model’s next choice, not an arbitrary one', () => {
    const { plan } = fitToTarget(profile, sparse(), 1);
    for (const w of plan.work) {
      const on = w.bullets.filter((b) => b.include).map((b) => b.order).sort((a, b) => a - b);
      // A contiguous run from the top of the model's ranking.
      expect(on).toEqual(on.map((_, i) => i));
    }
  });

  it('converges rather than oscillating', () => {
    // Trimming stops at the conservative line and filling stops at the
    // generous one, so an over-full plan may get one bullet back on the way
    // out. What must hold is that the result does not exceed the page, and
    // that running it again changes nothing.
    const once = fitToTarget(profile, keepAll(), 1);
    const twice = fitToTarget(profile, once.plan, 1);

    expect(once.fits).toBe(true);
    expect(twice.dropped).toEqual([]);
    expect(twice.added).toEqual([]);
  });
});

describe('a plan that does not cover the profile', () => {
  /**
   * A real run returned a plan describing one role — no projects, no skills,
   * two roles unmentioned. `buildDocument` treats an entry the plan is silent
   * about as kept, so the resume rendered every one of them in full: 49
   * bullets across four pages, against a one-page target, and the trim could
   * not touch any of it because none of it was in the plan.
   *
   * Silence is not a drop, and it is not a decision either. Filling the gaps in
   * with what the renderer would do anyway makes the whole document trimmable
   * without changing what it says.
   */
  const partial = (): TailorPlan =>
    tailorPlanSchema.parse({
      summary: { text: '', rationale: '' },
      work: [
        {
          id: profile.work[0]!.id,
          include: true,
          order: 0,
          bullets: profile.work[0]!.bullets.map((b, j) => ({ bulletId: b.id, include: j < 2, order: j })),
        },
      ],
      projects: [],
      skills: [],
    });

  it('brings the unmentioned entries under the plan', () => {
    const { plan } = fitToTarget(profile, partial(), 1);

    expect(plan.work).toHaveLength(profile.work.length);
    expect(plan.projects).toHaveLength(profile.projects.length);
    expect(plan.skills).toHaveLength(profile.skills.length);
  });

  it('fits the page, which it could not before', () => {
    expect(fitToTarget(profile, partial(), 1).fits).toBe(true);
  });

  it('leaves what the plan did say exactly as it was', () => {
    const { plan } = fitToTarget(profile, partial(), 1);
    const first = plan.work.find((w) => w.id === profile.work[0]!.id)!;

    expect(first.include).toBe(true);
    // The model chose these two; the trim may add or remove around them, but
    // nothing switches a stated decision to its opposite.
    expect(first.bullets.find((b) => b.bulletId === profile.work[0]!.bullets[0]!.id)!.include).toBe(true);
  });

  it('does not resurrect something the plan explicitly dropped', () => {
    const explicit = tailorPlanSchema.parse({
      ...partial(),
      projects: profile.projects.map((p, i) => ({
        id: p.id, include: false, order: i,
        bullets: p.bullets.map((b, j) => ({ bulletId: b.id, include: false, order: j })),
      })),
    });
    const { plan } = fitToTarget(profile, explicit, 1);
    expect(plan.projects.every((p) => !p.include)).toBe(true);
  });
});
