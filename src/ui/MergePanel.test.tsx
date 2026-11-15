// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { profileSchema, type Profile } from '../index';
import { planMerge, type ProfileMerge } from '../parse';
import { MergePanel } from './components/MergePanel';

/**
 * The merge review screen: a plan from `planMerge`, shown for a decision
 * before `applyMerge` ever runs.
 *
 * `applyMerge` is wrapped rather than replaced, so these tests exercise the
 * real merge logic and only observe how `MergePanel` calls it.
 */
vi.mock('../parse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../parse')>();
  return { ...actual, applyMerge: vi.fn(actual.applyMerge) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const LEDGER = 'Led the migration of the settlement ledger to a sharded design.';
const LEDGER_REWORDED = 'Led migration of the settlement ledger to a sharded design.';

function baseProfile(): Profile {
  return profileSchema.parse({
    id: 'prf_base',
    label: 'Master',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    basics: { name: 'Jordan Avery', email: 'jordan.avery@example.com' },
    work: [
      {
        id: 'wrk_northwind',
        name: 'Northwind Payments',
        position: 'Staff Engineer',
        startDate: '2021-03',
        endDate: '',
        bullets: [{ id: 'blt_ledger', text: LEDGER }],
      },
    ],
  });
}

function incomingProfile(): Profile {
  return profileSchema.parse({
    id: 'prf_incoming',
    label: 'resume-2025.pdf',
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    work: [
      {
        id: 'wrk_incoming',
        name: 'Northwind Payments',
        position: 'Staff Engineer',
        startDate: '2021-03',
        endDate: '',
        bullets: [{ id: 'blt_incoming', text: LEDGER_REWORDED }],
      },
    ],
    projects: [{ id: 'prj_incoming', name: 'Side Project', description: '', bullets: [] }],
  });
}

function plan(): ProfileMerge {
  return planMerge(baseProfile(), incomingProfile());
}

describe('MergePanel', () => {
  it('defaults every candidate to its suggested action', () => {
    render(<MergePanel base={baseProfile()} plan={plan()} onCommit={() => {}} onCancel={() => {}} />);

    const workArticle = screen.getByText('Staff Engineer · Northwind Payments').closest('article')!;
    const pressed = within(workArticle)
      .getAllByRole('button', { pressed: true })
      .map((b) => b.textContent);
    // One strong match (merge the role) and one reworded bullet (merge as a variant).
    expect(pressed).toEqual(['Merge into…', 'Merge into…']);

    const projectArticle = screen.getByText('Side Project').closest('article')!;
    expect(within(projectArticle).getByRole('button', { pressed: true }).textContent).toBe('Add');
  });

  it('leaves the skipped entry byte-identical to the base profile after Commit', () => {
    const base = baseProfile();
    let committed: Profile | null = null;
    render(
      <MergePanel
        base={base}
        plan={plan()}
        onCommit={(next) => {
          committed = next;
        }}
        onCancel={() => {}}
      />,
    );

    const workArticle = screen.getByText('Staff Engineer · Northwind Payments').closest('article')!;
    // The entry-level row is the first "Skip" in this article; the bullet
    // underneath it has its own.
    fireEvent.click(within(workArticle).getAllByRole('button', { name: 'Skip' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Commit merge' }));

    expect(committed).not.toBeNull();
    expect(committed!.work).toEqual(base.work);
  });

  it('passes the collected decisions to applyMerge', async () => {
    const { applyMerge } = await import('../parse');
    const base = baseProfile();
    const mergePlan = plan();
    const workKey = mergePlan.work[0]!.key;

    render(
      <MergePanel base={base} plan={mergePlan} sourceLabel="resume-2025.pdf" onCommit={() => {}} onCancel={() => {}} />,
    );

    const workArticle = screen.getByText('Staff Engineer · Northwind Payments').closest('article')!;
    fireEvent.click(within(workArticle).getAllByRole('button', { name: 'Skip' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Commit merge' }));

    expect(applyMerge).toHaveBeenCalledWith(base, mergePlan, {
      decisions: { [workKey]: 'skip' },
      sourceLabel: 'resume-2025.pdf',
    });
  });

  describe('GitHub provenance', () => {
    const prov = (url: string, artifact: 'readme' | 'manifest' | 'commits', ref: string) => ({
      repo: 'jordan/ledger-kit',
      artifact,
      ref,
      url,
      impact: 'blank' as const,
    });

    function githubIncoming(): Profile {
      return profileSchema.parse({
        id: 'prf_gh',
        label: 'GitHub',
        createdAt: '2025-06-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        projects: [
          {
            id: 'prj_gh',
            name: 'ledger-kit',
            description: '',
            bullets: [
              { id: 'blt_gh1', text: 'Built a sharded ledger library in TypeScript.' },
              { id: 'blt_gh2', text: 'Published the package manifest with typed exports.' },
            ],
          },
          {
            id: 'prj_resume',
            name: 'Resume Project',
            description: '',
            bullets: [{ id: 'blt_resume', text: 'Wrote the onboarding guide for new engineers.' }],
          },
        ],
      });
    }

    const provenance = {
      blt_gh1: prov('https://github.com/jordan/ledger-kit#design', 'readme', 'Design'),
      blt_gh2: prov('https://github.com/jordan/ledger-kit/blob/main/package.json', 'manifest', 'package.json'),
    };

    const ghPlan = () => planMerge(baseProfile(), githubIncoming());

    it('shows repo, artifact and a safe link under each provenance bullet', () => {
      render(
        <MergePanel base={baseProfile()} plan={ghPlan()} provenance={provenance} onCommit={() => {}} onCancel={() => {}} />,
      );
      const rows = screen.getAllByTestId('provenance');
      expect(rows).toHaveLength(2);
      for (const [row, p] of [
        [rows[0]!, provenance.blt_gh1],
        [rows[1]!, provenance.blt_gh2],
      ] as const) {
        expect(within(row).getByText('jordan/ledger-kit')).toBeTruthy();
        const link = within(row).getByRole('link');
        expect(link.getAttribute('href')).toBe(p.url);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      }
      expect(screen.getByRole('status').textContent).toContain('2 from GitHub');
    });

    it('renders a resume-import bullet with no provenance row', () => {
      render(
        <MergePanel base={baseProfile()} plan={ghPlan()} provenance={provenance} onCommit={() => {}} onCancel={() => {}} />,
      );
      const article = screen.getByText('Resume Project').closest('article')!;
      expect(within(article).queryByTestId('provenance')).toBeNull();
      expect(within(article).queryByText(/add your own impact/i)).toBeNull();
    });

    it('marks the impact blank and keeps it blank when accepted unedited', () => {
      let committed: Profile | null = null;
      render(
        <MergePanel
          base={baseProfile()}
          plan={ghPlan()}
          provenance={{ blt_gh1: provenance.blt_gh1 }}
          onCommit={(n) => {
            committed = n;
          }}
          onCancel={() => {}}
        />,
      );
      expect(screen.getByText(/add your own impact/i)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Commit merge' }));
      const texts = committed!.projects.flatMap((p) => p.bullets.map((b) => b.text));
      expect(texts).toContain('Built a sharded ledger library in TypeScript.');
      expect(texts.some((t) => /\d/.test(t))).toBe(false);
    });

    it('uses only what the person types into the impact blank', () => {
      let committed: Profile | null = null;
      render(
        <MergePanel
          base={baseProfile()}
          plan={ghPlan()}
          provenance={{ blt_gh1: provenance.blt_gh1 }}
          onCommit={(n) => {
            committed = n;
          }}
          onCancel={() => {}}
        />,
      );
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Cut settlement time.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Commit merge' }));
      const texts = committed!.projects.flatMap((p) => p.bullets.map((b) => b.text));
      expect(texts).toContain('Built a sharded ledger library in TypeScript. Cut settlement time.');
    });
  });
});
