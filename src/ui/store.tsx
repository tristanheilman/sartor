import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  PROVIDER_LIST,
  getProvider,
  writeBackVariants,
  newId,
  type Change,
  type Profile,
  type ResumeDocument,
  type TailorRun,
  type Template,
} from '../index';
import * as db from '../storage/db';
import { getApiKey, setApiKey as persistKey, clearApiKey } from '../storage/keys';

interface Store {
  ready: boolean;
  /** Set when local storage could not be opened at all. */
  failure: string | null;
  settings: db.StoredSettings;
  profiles: Profile[];
  profile: Profile | null;
  run: TailorRun | null;
  /** Past runs for the active profile, newest first. */
  runs: TailorRun[];
  /** Documents this browser has produced for the active profile, newest first. */
  exports: db.ExportRecord[];
  /** Present only for the current tab session. */
  apiKey: string | null;

  updateSettings(patch: Partial<db.StoredSettings>): Promise<void>;
  selectProfile(id: string): Promise<void>;
  upsertProfile(profile: Profile): Promise<Profile>;
  removeProfile(id: string): Promise<void>;
  setRun(run: TailorRun | null): void;
  openRun(id: string): Promise<void>;
  removeRun(id: string): Promise<void>;
  updateChange(changeId: string, patch: Partial<Change>): void;
  commitRun(): Promise<void>;
  recordExport(input: {
    label: string;
    fileBase: string;
    formats: string[];
    template: Template;
    pageTarget: 1 | 2;
    doc: ResumeDocument;
  }): Promise<void>;
  removeExport(id: string): Promise<void>;
  /** The profile being worked on but not yet confirmed, restored across reloads. */
  draft: Profile | null;
  saveDraft(profile: Profile | null): Promise<void>;
  saveKey(key: string): void;
  forgetKey(): void;
  eraseEverything(): Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState<db.StoredSettings>(db.DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [run, setRun] = useState<TailorRun | null>(null);
  const [runs, setRuns] = useState<TailorRun[]>([]);
  const [exports, setExports] = useState<db.ExportRecord[]>([]);
  const [apiKey, setKeyState] = useState<string | null>(null);
  const [draft, setDraftState] = useState<Profile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedProfiles, loadedDraft] = await Promise.all([
        db.loadSettings(),
        db.listProfiles(),
        db.loadDraft(),
      ]);
      setSettings(loadedSettings);
      setProfiles(loadedProfiles);
      setDraftState(loadedDraft);
      const active =
        loadedProfiles.find((p) => p.id === loadedSettings.activeProfileId) ?? loadedProfiles[0] ?? null;
      setProfile(active);
      setKeyState(getApiKey(loadedSettings.providerId));
      setReady(true);
    })().catch((err: unknown) => {
      // Without this the app sits on "Loading…" forever. A blocked upgrade is
      // the common cause and it has a specific, actionable fix.
      setFailure(err instanceof Error ? err.message : String(err));
    });
  }, []);

  // History follows whichever profile is active. Runs belong to a profile, and
  // showing another profile's history would be actively misleading.
  useEffect(() => {
    if (!profile) {
      setRuns([]);
      return;
    }
    void db.listRuns(profile.id).then(setRuns);
  }, [profile?.id, run]);

  useEffect(() => {
    if (!profile) {
      setExports([]);
      return;
    }
    void db.listExports(profile.id).then(setExports);
  }, [profile?.id]);

  const updateSettings = useCallback(async (patch: Partial<db.StoredSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void db.saveSettings(next);
      // Keys are per-provider, so switching provider swaps which key is in play.
      if (patch.providerId && patch.providerId !== prev.providerId) {
        setKeyState(getApiKey(patch.providerId));
      }
      return next;
    });
  }, []);

  const selectProfile = useCallback(
    async (id: string) => {
      const found = await db.getProfile(id);
      if (found) {
        setProfile(found);
        setRun(null);
        await updateSettings({ activeProfileId: id });
      }
    },
    [updateSettings],
  );

  const upsertProfile = useCallback(
    async (next: Profile) => {
      const saved = await db.saveProfile(next);
      setProfiles((prev) => {
        const without = prev.filter((p) => p.id !== saved.id);
        return [...without, saved].sort((a, b) => a.label.localeCompare(b.label));
      });
      setProfile((prev) => (prev?.id === saved.id || prev === null ? saved : prev));
      if (settings.activeProfileId !== saved.id) {
        await updateSettings({ activeProfileId: saved.id });
      }
      return saved;
    },
    [settings.activeProfileId, updateSettings],
  );

  const removeProfile = useCallback(
    async (id: string) => {
      await db.deleteProfile(id);
      const remaining = await db.listProfiles();
      setProfiles(remaining);
      setProfile((prev) => (prev?.id === id ? (remaining[0] ?? null) : prev));
      setRun((prev) => (prev?.profileId === id ? null : prev));
    },
    [],
  );

  /** Reopens a past run for re-review and re-export. Nothing is recomputed. */
  const openRun = useCallback(async (id: string) => {
    const found = await db.getRun(id);
    if (found) setRun(found);
  }, []);

  const removeRun = useCallback(
    async (id: string) => {
      await db.deleteRun(id);
      setRuns((prev) => prev.filter((r) => r.id !== id));
      setRun((prev) => (prev?.id === id ? null : prev));
    },
    [],
  );

  const updateChange = useCallback((changeId: string, patch: Partial<Change>) => {
    setRun((prev) => {
      if (!prev) return prev;
      const next = {
        ...prev,
        changes: prev.changes.map((c) => (c.id === changeId ? { ...c, ...patch } : c)),
      };
      void db.saveRun(next);
      return next;
    });
  }, []);

  /**
   * Persists the run and folds accepted rephrasings back into the master
   * profile as variants. This is what makes the profile improve with use.
   */
  const commitRun = useCallback(async () => {
    if (!run || !profile) return;
    await db.saveRun(run);
    setRuns(await db.listRuns(profile.id));
    const next = writeBackVariants(profile, run);
    if (next !== profile) {
      const saved = await db.saveProfile(next);
      setProfile(saved);
      setProfiles((prev) => prev.map((p) => (p.id === saved.id ? saved : p)));
    }
  }, [run, profile]);

  /**
   * Records a document that was actually downloaded.
   *
   * Called after the file is saved rather than before, so a render that throws
   * leaves no record of a document the user never received.
   */
  const recordExport = useCallback<Store['recordExport']>(
    async (input) => {
      if (!profile) return;
      const record: db.ExportRecord = {
        id: newId('exp'),
        profileId: profile.id,
        runId: run?.id ?? null,
        createdAt: new Date().toISOString(),
        ...input,
      };
      await db.saveExport(record);
      setExports((prev) => [record, ...prev]);
    },
    [profile, run],
  );

  const removeExport = useCallback(async (id: string) => {
    await db.deleteExport(id);
    setExports((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const saveKey = useCallback(
    (key: string) => {
      persistKey(settings.providerId, key);
      setKeyState(key.trim());
    },
    [settings.providerId],
  );

  const forgetKey = useCallback(() => {
    clearApiKey(settings.providerId);
    setKeyState(null);
  }, [settings.providerId]);

  /**
   * Persists the profile being worked on, or clears it.
   *
   * Written on every answer rather than on a timer: the interview is a series
   * of discrete commits, and losing the most recent one is exactly what makes
   * a reload feel like starting over.
   */
  const saveDraft = useCallback(async (next: Profile | null) => {
    setDraftState(next);
    if (next) await db.saveDraft(next);
    else await db.clearDraft();
  }, []);

  const eraseEverything = useCallback(async () => {
    await db.eraseEverything();
    await db.clearDraft();
    setDraftState(null);
    setProfiles([]);
    setProfile(null);
    setRun(null);
    setRuns([]);
    setExports([]);
    setSettings(db.DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<Store>(
    () => ({
      ready,
      failure,
      settings,
      profiles,
      profile,
      run,
      runs,
      exports,
      apiKey,
      draft,
      saveDraft,
      updateSettings,
      selectProfile,
      upsertProfile,
      removeProfile,
      setRun,
      openRun,
      removeRun,
      updateChange,
      commitRun,
      recordExport,
      removeExport,
      saveKey,
      forgetKey,
      eraseEverything,
    }),
    [
      ready,
      failure,
      settings,
      profiles,
      profile,
      run,
      runs,
      exports,
      apiKey,
      draft,
      saveDraft,
      updateSettings,
      selectProfile,
      upsertProfile,
      removeProfile,
      openRun,
      removeRun,
      updateChange,
      commitRun,
      recordExport,
      removeExport,
      saveKey,
      forgetKey,
      eraseEverything,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

/** The provider currently selected, plus whether it is usable right now. */
export function useActiveProvider() {
  const { settings, apiKey } = useStore();
  const provider = getProvider(settings.providerId);
  return {
    provider,
    config: { apiKey: apiKey ?? '', model: settings.model },
    ready: Boolean(apiKey),
    all: PROVIDER_LIST,
  };
}
