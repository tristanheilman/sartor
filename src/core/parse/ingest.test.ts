import { describe, it, expect } from 'vitest';
import { rawToProfile, INGEST_JSON_SCHEMA, INGEST_SYSTEM_PROMPT } from './ingest';

/**
 * What survives the trip from a model response to a stored profile.
 *
 * These are transcription tests, not model tests: given exactly what the model
 * returned, does the profile keep it? The failure this guards against is the
 * quiet one — a field the schema has, the renderer prints, and the mapping
 * drops on the floor, so the loss is invisible until someone compares the
 * export against the original resume line by line.
 */

/**
 * `rawToProfile` runs on model output that has already been through the raw
 * zod schema, so every field is present. These fixtures mirror that guarantee
 * rather than bypassing it — handing it a half-built object would test a shape
 * production never produces.
 */
const BASICS = {
  name: '',
  label: '',
  email: '',
  phone: '',
  url: '',
  summary: '',
  city: '',
  region: '',
  profiles: [],
};

const raw = (patch: { basics?: Record<string, unknown> } & Record<string, unknown>) =>
  rawToProfile(
    {
      work: [],
      education: [],
      projects: [],
      skills: [],
      certificates: [],
      awards: [],
      ...patch,
      basics: { ...BASICS, ...(patch.basics ?? {}) },
    } as never,
    'Test',
  );

describe('contact links', () => {
  it('carries LinkedIn and GitHub through to the profile', () => {
    const p = raw({
      basics: {
        name: 'Dana Reyes',
        url: 'dana.example.com',
        profiles: [
          { network: 'LinkedIn', username: 'dana', url: 'linkedin.com/in/dana' },
          { network: 'GitHub', username: 'dana', url: 'github.com/dana' },
        ],
      },
    });

    expect(p.basics.profiles.map((x) => x.network)).toEqual(['LinkedIn', 'GitHub']);
    expect(p.basics.profiles[0]?.url).toBe('linkedin.com/in/dana');
    // The personal site stays where it was, not duplicated into the list.
    expect(p.basics.url).toBe('dana.example.com');
  });

  it('drops a link the reader could not follow', () => {
    const p = raw({
      basics: {
        profiles: [
          { network: 'GitHub', username: '', url: '' },
          { network: '', username: '', url: 'example.com/x' },
          { network: 'NPM', username: 'dana', url: '' },
        ],
      },
    });

    // Only the one that names a network *and* points somewhere survives.
    expect(p.basics.profiles).toHaveLength(1);
    expect(p.basics.profiles[0]?.network).toBe('NPM');
  });

  it('defaults to no links rather than undefined when the model omits the field', () => {
    expect(raw({ basics: { name: 'Dana' } }).basics.profiles).toEqual([]);
  });

  it('asks the model for the field it is expected to fill', () => {
    // A mapping that reads `profiles` while the schema never offers it would
    // pass every test above and still return nothing in production.
    expect(INGEST_JSON_SCHEMA.properties.basics.properties).toHaveProperty('profiles');
    expect(INGEST_JSON_SCHEMA.properties.basics.required).toContain('profiles');
    expect(INGEST_SYSTEM_PROMPT).toContain('basics.profiles');
  });
});

describe('transcription', () => {
  it('keeps bullets in order and drops blank ones', () => {
    const p = raw({
      work: [
        {
          name: 'Acme',
          position: 'Engineer',
          bullets: [{ text: 'Shipped it' }, { text: '   ' }, { text: 'Fixed it' }],
        },
      ],
    });

    expect(p.work[0]?.bullets.map((b) => b.text)).toEqual(['Shipped it', 'Fixed it']);
    expect(p.work[0]?.bullets[0]?.id).toMatch(/^blt_/);
  });

  it('gives every entry a stable prefixed id', () => {
    const p = raw({
      work: [{ name: 'Acme', position: 'Engineer', bullets: [] }],
      projects: [{ name: 'Thing', bullets: [] }],
      education: [{ institution: 'TU Berlin', bullets: [] }],
    });

    expect(p.work[0]?.id).toMatch(/^wrk_/);
    expect(p.projects[0]?.id).toMatch(/^prj_/);
    expect(p.education[0]?.id).toMatch(/^edu_/);
  });
});
