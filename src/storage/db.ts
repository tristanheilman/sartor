import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  safeParseProfile,
  profileSchema,
  templateSchema,
  type Profile,
  type ResumeDocument,
  type TailorRun,
  type Template,
} from '../index';

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
  /** Templates the user built. Stored whole rather than as a patch on a
   * built-in, so editing or removing a built-in can never silently change a
   * document someone already exported from. */
  customTemplates: Template[];
}

/**
 * One record of a document this browser produced.
 *
 * The point is to be able to answer "what exactly did I send them, and when?"
 * months later, when the profile has moved on. So the record keeps its own
 * copies of the document and the template rather than pointing at the profile
 * and run they came from: editing your master profile must never rewrite
 * history, and deleting a run must not erase the evidence of what it produced.
 *
 * It stores the document, not the rendered bytes. Rendering is deterministic
 * from `doc` plus `template`, so any format can be regenerated on demand, and a
 * year of exports costs kilobytes instead of megabytes. The tradeoff is honest
 * and worth naming: if a future change alters a renderer, a regenerated file
 * could differ in layout from the one originally sent. The words cannot drift —
 * those are in `doc` — but the pixels could.
 */
export interface ExportRecord {
  id: string;
  profileId: string;
  /** The tailor run this came from, or null for a master-profile export. */
  runId: string | null;
  createdAt: string;
  /** What the user called it — company and role, when there was a posting. */
  label: string;
  fileBase: string;
  /** Formats actually downloaded, in the order they were asked for. */
  formats: string[];
  /** Resolved and copied, so deleting a custom template cannot orphan it. */
  template: Template;
  pageTarget: 1 | 2;
  doc: ResumeDocument;
}

interface SartorDB extends DBSchema {
  profiles: { key: string; value: Profile };
  runs: { key: string; value: TailorRun; indexes: { byProfile: string; byCreated: string } };
  settings: { key: string; value: StoredSettings };
  exports: { key: string; value: ExportRecord; indexes: { byProfile: string; byCreated: string } };
  /**
   * A profile being worked on but not yet confirmed.
   *
   * The interview deliberately runs against an unsaved profile so someone can
   * walk away from the whole thing. That also meant a refresh, a crash or a
   * closed tab threw away every answer they had given — which for a flow that
   * asks a dozen questions is the difference between a demo and something you
   * would trust with a real evening's work.
   *
   * One slot, keyed by a constant: there is only ever one draft in flight, and
   * a list of half-finished profiles would be its own kind of mess.
   */
  drafts: { key: string; value: { id: string; profile: Profile; savedAt: string } };
}

const DB_NAME = 'sartor';
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<SartorDB>> | null = null;

/**
 * Raised when another tab is holding the database at an older version.
 *
 * IndexedDB will not upgrade a schema while any connection to the old version
 * is open, and by default it simply never resolves — so a version bump left
 * the app sitting on "Loading your local data…" forever with nothing to act
 * on. Failing loudly is the only honest option: the fix is to close the other
 * tab, and nobody can do that if they are not told.
 */
export class DatabaseBlockedError extends Error {
  constructor() {
    super(
      'Another tab has this app open on an older version. Close the other tabs and reload — ' +
        'the browser cannot upgrade the local database while they are holding it open.',
    );
  }
}

function db() {
  dbPromise ??= openDB<SartorDB>(DB_NAME, DB_VERSION, {
    // Stepwise and additive: a browser sitting at version 1 with real profiles
    // in it must gain the new store without touching the old ones.
    upgrade(database, oldVersion) {
      if (oldVersion < 3) {
        if (!database.objectStoreNames.contains('drafts')) {
          database.createObjectStore('drafts', { keyPath: 'id' });
        }
      }
      if (oldVersion < 1) {
        database.createObjectStore('profiles', { keyPath: 'id' });
        const runs = database.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('byProfile', 'profileId');
        runs.createIndex('byCreated', 'createdAt');
        database.createObjectStore('settings', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        const exports = database.createObjectStore('exports', { keyPath: 'id' });
        exports.createIndex('byProfile', 'profileId');
        exports.createIndex('byCreated', 'createdAt');
      }
    },

    /**
     * Another connection is holding the old version open. Say so rather than
     * hanging: the promise would otherwise never settle.
     */
    blocked() {
      throw new DatabaseBlockedError();
    },

    /**
     * This tab is the one in the way of someone else's upgrade. Close and let
     * them through — a stale tab should not hold a newer one hostage.
     */
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase | null)?.close();
      dbPromise = null;
    },

    /** The browser dropped the connection. Reconnect on the next call. */
    terminated() {
      dbPromise = null;
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
  customTemplates: [],
};

export async function loadSettings(): Promise<StoredSettings> {
  const stored = await (await db()).get('settings', 'settings');
  const merged = { ...DEFAULT_SETTINGS, ...stored, id: 'settings' as const };
  // Custom templates are the one setting a person can put arbitrary numbers
  // into. Re-validate on the way out of storage so a template edited by hand —
  // or written by a version of this app with different bounds — cannot reach a
  // renderer with a 4pt body font.
  return {
    ...merged,
    customTemplates: (merged.customTemplates ?? []).filter(
      (t) => templateSchema.safeParse(t).success,
    ),
  };
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
  // Exports outlive their run, but not the profile they describe. Deleting a
  // profile is an explicit "remove this person's data", and an orphaned export
  // would keep a full copy of it out of sight.
  const exportIds = await database.getAllKeysFromIndex('exports', 'byProfile', id);
  await Promise.all(exportIds.map((eid) => database.delete('exports', eid)));
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

export async function saveExport(record: ExportRecord): Promise<void> {
  await (await db()).put('exports', record);
}

export async function listExports(profileId: string): Promise<ExportRecord[]> {
  const all = await (await db()).getAllFromIndex('exports', 'byProfile', profileId);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteExport(id: string): Promise<void> {
  await (await db()).delete('exports', id);
}

/** Wipes every trace of the user's data from this browser. */
export async function eraseEverything(): Promise<void> {
  const database = await db();
  await Promise.all([
    database.clear('profiles'),
    database.clear('runs'),
    database.clear('settings'),
    database.clear('exports'),
  ]);
}

/* ------------------------------------------------------------------ *
 * The draft in flight
 * ------------------------------------------------------------------ */

const DRAFT_KEY = 'current';

/** Stores the profile being worked on, so a reload does not lose the answers. */
export async function saveDraft(profile: Profile): Promise<void> {
  await (await db()).put('drafts', { id: DRAFT_KEY, profile, savedAt: new Date().toISOString() });
}

/**
 * The draft, if there is one.
 *
 * Re-validated like everything else read back from storage: a record written
 * by an older schema must surface here, not three screens later inside a
 * renderer.
 */
export async function loadDraft(): Promise<Profile | null> {
  const row = await (await db()).get('drafts', DRAFT_KEY);
  if (!row) return null;
  const parsed = safeParseProfile(row.profile);
  return parsed.success ? parsed.data : null;
}

export async function clearDraft(): Promise<void> {
  await (await db()).delete('drafts', DRAFT_KEY);
}
