import { describe, it, expect } from 'vitest';
import { proposeFromEvidence } from './propose';
import type { RepoEvidence } from './github';
import type { LLMProvider } from '../provider';
import { emptyProfile } from '../schema';
import { planMerge } from '../parse/merge';

const evidence: RepoEvidence[] = [
  {
    repo: {
      name: 'widget',
      fullName: 'me/widget',
      description: 'A widget service',
      visibility: 'public',
      pushedAt: '2024-05-01T00:00:00Z',
      url: 'https://github.com/me/widget',
    },
    languages: { names: ['TypeScript', 'Go'], url: 'https://api.github.com/repos/me/widget/languages' },
    topics: { names: ['cli'], url: 'https://github.com/me/widget' },
    commits: {
      firstCommitDate: '2023-01-10T00:00:00Z',
      lastCommitDate: '2024-05-01T00:00:00Z',
      authorCommitCount: 120,
      url: 'https://api.github.com/repos/me/widget/commits?per_page=1',
    },
    readme: { text: '# Widget\n\n## Install\nSupports 3 platforms.', truncated: false, url: 'https://github.com/me/widget#readme' },
    manifest: [
      { filename: 'package.json', text: '{"dependencies":{"zod":"^4"}}', truncated: false, url: 'https://github.com/me/widget/blob/main/package.json' },
    ],
  },
];

const stub = (json: unknown): LLMProvider => ({
  info: {} as LLMProvider['info'],
  complete: async () => ({ text: '', json, model: 'stub' }),
});
const cfg = { apiKey: 'k', model: 'm' };

const response = (bullets: unknown[]) => ({
  projects: [{ repo: 'me/widget', name: 'Widget', description: 'A service', id: 'prj_model', bullets }],
  skills: [{ name: 'Languages', keywords: ['TypeScript', 'Rust'] }],
});

describe('proposeFromEvidence', () => {
  it('gives every bullet a repo, artifact kind and URL, and feeds planMerge', async () => {
    const out = await proposeFromEvidence(
      evidence,
      stub(
        response([
          { text: 'Built a CLI supporting 3 platforms', artifact: 'readme', ref: 'Install' },
          { text: 'Validated config with zod', artifact: 'manifest', ref: 'package.json' },
        ]),
      ),
      cfg,
    );
    const bullets = out.profile.projects.flatMap((p) => p.bullets);
    expect(bullets).toHaveLength(2);
    for (const b of bullets) {
      const p = out.provenance[b.id];
      expect(p?.repo).toBe('me/widget');
      expect(p?.artifact).toBeTruthy();
      expect(p?.url).toMatch(/^https:\/\//);
    }
    expect(out.provenance[bullets[1]!.id]!.url).toBe(evidence[0]!.manifest![0]!.url);
    expect(out.profile.projects[0]!.startDate).toBe('2023-01');
    // Skills the evidence never mentions are dropped.
    expect(out.profile.skills[0]!.keywords).toEqual(['TypeScript']);
    expect(() => planMerge(emptyProfile('prf_existing'), out.profile)).not.toThrow();
  });

  it('drops a bullet whose metric is absent from the evidence', async () => {
    const out = await proposeFromEvidence(
      evidence,
      stub(
        response([
          { text: 'Cut latency 40%', artifact: 'readme', ref: 'Install' },
          { text: 'Supports 3 platforms', artifact: 'readme', ref: 'Install' },
        ]),
      ),
      cfg,
    );
    const texts = out.profile.projects[0]!.bullets.map((b) => b.text);
    expect(texts).toEqual(['Supports 3 platforms']);
    expect(out.dropped.join('\n')).toContain('40');
  });

  it('drops a bullet citing evidence that was not read', async () => {
    const noReadme = [{ ...evidence[0]!, readme: null }];
    const out = await proposeFromEvidence(
      noReadme,
      stub(response([{ text: 'Wrote docs', artifact: 'readme', ref: '' }])),
      cfg,
    );
    expect(out.profile.projects[0]!.bullets).toHaveLength(0);
  });

  it('ignores model IDs and mints fresh ones', async () => {
    const out = await proposeFromEvidence(
      evidence,
      stub(response([{ id: 'blt_model', text: 'Wrote a CLI', artifact: 'commits', ref: '2023-01..2024-05' }])),
      cfg,
    );
    expect(out.profile.projects[0]!.id).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(out.profile.projects[0]!.id).not.toBe('prj_model');
    expect(out.profile.projects[0]!.bullets[0]!.id).toMatch(/^blt_[0-9a-f]{16}$/);
  });
});
