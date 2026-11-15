import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const extDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = (path: string) =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

const manifest = readManifest(join(extDir, 'manifest.json'));

describe('manifest permissions', () => {
  it('asks for exactly activeTab and scripting', () => {
    expect(manifest.permissions).toEqual(['activeTab', 'scripting']);
  });

  it('has no host permissions, static content scripts or network access', () => {
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest).not.toHaveProperty('optional_host_permissions');
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest).not.toHaveProperty('externally_connectable');
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
  });

  it('does not claim to be unimplemented', () => {
    expect(String(manifest.description)).not.toMatch(/scaffold|not implemented/i);
  });
});

describe('built manifest', () => {
  const built = join(extDir, 'dist', 'manifest.json');
  // Present after `npm run build:extension`, which CI runs before the tests.
  it.skipIf(!existsSync(built))('references only files that exist', () => {
    const m = readManifest(built) as {
      background?: { service_worker?: string };
      icons?: Record<string, string>;
    };
    const paths = [m.background?.service_worker, ...Object.values(m.icons ?? {})];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(existsSync(join(extDir, 'dist', p as string)), String(p)).toBe(true);
    }
  });
});
