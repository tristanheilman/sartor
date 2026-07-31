import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { profileSchema, type Profile, type TailorRun } from '../index';

/**
 * All persistent state lives here, in the user's own browser. There is no
 * server, no account, and no sync. Deleting site data deletes everything.
 */

export interface StoredSettings {
  id: 'settings';
  providerId: string;
  model: string;
  activeProfileId: string | null;
  /** Page-count target for rendering, in pages. */
  pageTarget: 1 | 2;
  templateId: string;
}

interface SartorDB extends DBSchema {
  profiles: { key: string; value: Profile };
  runs: { key: string; value: TailorRun; indexes: { byProfile: string; byCreated: string } };
  settings: { key: string; value: StoredSettings };
}

const DB_NAME = 'sartor';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<SartorDB>> | null = null;

function db() {
  dbPromise ??= openDB<SartorDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('profiles', { keyPath: 'id' });
      const runs = database.createObjectStore('runs', { keyPath: 'id' });
      runs.createIndex('byProfile', 'profileId');
      runs.createIndex('byCreated', 'createdAt');
      database.createObjectStore('settings', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  id: 'settings',
  providerId: 'anthropic',
  model: 'claude-opus-5',
  activeProfileId: null,
  pageTarget: 1,
  templateId: 'classic',
};

export async function loadSettings(): Promise<StoredSettings> {
  const stored = await (await db()).get('settings', 'settings');
  return { ...DEFAULT_SETTINGS, ...stored, id: 'settings' };
}

export async function saveSettings(settings: StoredSettings): Promise<void> {
  await (await db()).put('settings', settings);
}

export async function listProfiles(): Promise<Profile[]> {
  const all = await (await db()).getAll('profiles');
  // Stored data is re-validated on read: a schema migration or a corrupted
  // record should surface here, not three screens later inside a renderer.
  return all.flatMap((p) => {
    const parsed = profileSchema.safeParse(p);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  const raw = await (await db()).get('profiles', id);
  if (!raw) return undefined;
  const parsed = profileSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const next = { ...profile, updatedAt: new Date().toISOString() };
  await (await db()).put('profiles', next);
  return next;
}

export async function deleteProfile(id: string): Promise<void> {
  const database = await db();
  await database.delete('profiles', id);
  const runIds = await database.getAllKeysFromIndex('runs', 'byProfile', id);
  await Promise.all(runIds.map((rid) => database.delete('runs', rid)));
}

export async function saveRun(run: TailorRun): Promise<void> {
  await (await db()).put('runs', run);
}

export async function listRuns(profileId: string): Promise<TailorRun[]> {
  const runs = await (await db()).getAllFromIndex('runs', 'byProfile', profileId);
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRun(id: string): Promise<TailorRun | undefined> {
  return (await db()).get('runs', id);
}

export async function deleteRun(id: string): Promise<void> {
  await (await db()).delete('runs', id);
}

/** Wipes every trace of the user's data from this browser. */
export async function eraseEverything(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear('profiles'),
    database.clear('runs'),
    database.clear('settings'),
  ]);
}
