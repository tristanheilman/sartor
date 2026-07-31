// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { profileSchema, type Profile } from '../core/schema';
import type { TailorRun } from '../core/tailor/apply';
import * as db from './db';

/**
 * Storage round-trip tests.
 *
 * Two properties matter here beyond "it saves": that reads re-validate (a
 * corrupted record must not reach a renderer), and that deleting a profile also
 * removes its runs — history that outlives its profile is both a data leak and
 * a source of orphaned UI.
 */

function makeProfile(id: string, label = 'Test'): Profile {
  return profileSchema.parse({
    id,
    label,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    basics: { name: 'Dana Reyes', email: 'dana@example.com' },
    work: [{ id: 'wrk_1', name: 'Acme', position: 'Engineer', bullets: [{ id: 'blt_1', text: 'Shipped it' }] }],
  });
}

function makeRun(id: string, profileId: string, createdAt: string, title = 'Backend Engineer'): TailorRun {
  return {
    id,
    profileId,
    createdAt,
    providerId: 'anthropic',
    model: 'claude-opus-5',
    jd: { title, company: 'Globex', location: '', url: '', text: 'We need Go.', source: 'paste' },
    constraints: { pageTarget: 1, tone: 'plain', seniority: '' },
    plan: {
      summary: { text: '', rationale: '' },
      sectionOrder: ['summary', 'skills', 'work', 'projects', 'education', 'certificates', 'awards'],
      work: [],
      projects: [],
      education: [],
      skills: [],
      notes: '',
    },
    changes: [],
    notes: '',
  };
}

beforeEach(async () => {
  await db.eraseEverything();
});

describe('profiles', () => {
  it('round-trips a profile', async () => {
    await db.saveProfile(makeProfile('prf_1'));
    const loaded = await db.getProfile('prf_1');
    expect(loaded?.basics.name).toBe('Dana Reyes');
    expect(loaded?.work[0]?.bullets[0]?.id).toBe('blt_1');
  });

  it('stamps updatedAt on save', async () => {
    const saved = await db.saveProfile(makeProfile('prf_1'));
    expect(saved.updatedAt).not.toBe('2026-01-01T00:00:00Z');
  });

  it('returns undefined for a profile that does not exist', async () => {
    expect(await db.getProfile('prf_nope')).toBeUndefined();
  });

  it('drops records that no longer satisfy the schema instead of returning them', async () => {
    await db.saveProfile(makeProfile('prf_good'));
    // Simulate a corrupted or migrated-away record written by an older build.
    await db.saveProfile({ id: 'prf_bad', work: 'not an array' } as unknown as Profile);
    const all = await db.listProfiles();
    expect(all.map((p) => p.id)).toEqual(['prf_good']);
  });
});

describe('runs', () => {
  it('lists runs for a profile, newest first', async () => {
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z', 'Older'));
    await db.saveRun(makeRun('run_b', 'prf_1', '2026-03-01T00:00:00Z', 'Newer'));
    const runs = await db.listRuns('prf_1');
    expect(runs.map((r) => r.jd.title)).toEqual(['Newer', 'Older']);
  });

  it('scopes runs to their own profile', async () => {
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z'));
    await db.saveRun(makeRun('run_b', 'prf_2', '2026-02-01T00:00:00Z'));
    expect(await db.listRuns('prf_1')).toHaveLength(1);
    expect(await db.listRuns('prf_2')).toHaveLength(1);
  });

  it('round-trips a single run by id', async () => {
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z'));
    expect((await db.getRun('run_a'))?.jd.company).toBe('Globex');
  });

  it('deletes a run without touching its siblings', async () => {
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z'));
    await db.saveRun(makeRun('run_b', 'prf_1', '2026-03-01T00:00:00Z'));
    await db.deleteRun('run_a');
    expect((await db.listRuns('prf_1')).map((r) => r.id)).toEqual(['run_b']);
  });

  it('deleting a profile also deletes its history, and only its history', async () => {
    await db.saveProfile(makeProfile('prf_1'));
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z'));
    await db.saveRun(makeRun('run_b', 'prf_2', '2026-02-01T00:00:00Z'));

    await db.deleteProfile('prf_1');

    expect(await db.getProfile('prf_1')).toBeUndefined();
    expect(await db.listRuns('prf_1')).toEqual([]);
    expect(await db.listRuns('prf_2')).toHaveLength(1);
  });
});

describe('settings', () => {
  it('returns defaults before anything is saved', async () => {
    const s = await db.loadSettings();
    expect(s.providerId).toBe('anthropic');
    expect(s.model).toBe('claude-opus-5');
  });

  it('merges saved settings over defaults, so a new field never reads undefined', async () => {
    await db.saveSettings({ ...db.DEFAULT_SETTINGS, templateId: 'serif' });
    const s = await db.loadSettings();
    expect(s.templateId).toBe('serif');
    expect(s.pageTarget).toBe(1);
  });
});

describe('eraseEverything', () => {
  it('clears profiles, runs, and settings together', async () => {
    await db.saveProfile(makeProfile('prf_1'));
    await db.saveRun(makeRun('run_a', 'prf_1', '2026-02-01T00:00:00Z'));
    await db.saveSettings({ ...db.DEFAULT_SETTINGS, templateId: 'compact' });

    await db.eraseEverything();

    expect(await db.listProfiles()).toEqual([]);
    expect(await db.listRuns('prf_1')).toEqual([]);
    expect((await db.loadSettings()).templateId).toBe('classic');
  });
});
