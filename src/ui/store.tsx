import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Profile } from '../core/schema';
import type { TailorRun, Change } from '../core/tailor/apply';
import { writeBackVariants } from '../core/tailor/apply';
import * as db from '../storage/db';
import { getApiKey, setApiKey as persistKey, clearApiKey } from '../storage/keys';
import { getProvider, PROVIDER_LIST } from '../core/provider';

interface Store {
  ready: boolean;
  settings: db.StoredSettings;
  profiles: Profile[];
  profile: Profile | null;
  run: TailorRun | null;
  /** Past runs for the active profile, newest first. */
  runs: TailorRun[];
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
  const [apiKey, setKeyState] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [loadedSettings, loadedProfiles] = await Promise.all([db.loadSettings(), db.listProfiles()]);
      setSettings(loadedSettings);
      setProfiles(loadedProfiles);
      const active =
        loadedProfiles.find((p) => p.id === loadedSettings.activeProfileId) ?? loadedProfiles[0] ?? null;
      setProfile(active);
      setKeyState(getApiKey(loadedSettings.providerId));
      setReady(true);
    })();
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

  const eraseEverything = useCallback(async () => {
    await db.eraseEverything();
    setProfiles([]);
    setProfile(null);
    setRun(null);
    setRuns([]);
    setSettings(db.DEFAULT_SETTINGS);
  }, []);

  const value = useMemo<Store>(
    () => ({
      ready,
      settings,
      profiles,
      profile,
      run,
      runs,
      apiKey,
      updateSettings,
      selectProfile,
      upsertProfile,
      removeProfile,
      setRun,
      openRun,
      removeRun,
      updateChange,
      commitRun,
      saveKey,
      forgetKey,
      eraseEverything,
    }),
    [
      ready,
      settings,
      profiles,
      profile,
      run,
      runs,
      apiKey,
      updateSettings,
      selectProfile,
      upsertProfile,
      removeProfile,
      openRun,
      removeRun,
      updateChange,
      commitRun,
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
