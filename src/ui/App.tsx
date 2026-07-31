import { useMemo, useState } from 'react';
import { StoreProvider, useStore, useActiveProvider } from './store';
import { KeyPanel } from './components/KeyPanel';
import { ProfileEditor } from './components/ProfileEditor';
import { ImportPanel } from './components/ImportPanel';
import { JobPanel } from './components/JobPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { ExportPanel } from './components/ExportPanel';
import type { Profile } from '@/core/schema';
import type { JobDescription } from '@/core/jd/normalize';
import { DEFAULT_CONSTRAINTS, type TailorConstraints } from '@/core/tailor/prompt';
import { runTailor } from '@/core/tailor/run';
import { buildDocument, blockingChanges } from '@/core/tailor/apply';
import { buildCoverage } from '@/core/tailor/coverage';
import { documentToSlices } from '@/core/render/model';

type Step = 'profile' | 'job' | 'review' | 'export';

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const store = useStore();
  const { ready: keyReady } = useActiveProvider();
  const [step, setStep] = useState<Step>('profile');

  if (!store.ready) {
    return <div className="p-10 text-sm text-stone-500">Loading your local data…</div>;
  }

  const hasProfile = store.profile !== null;
  const hasRun = store.run !== null;

  const steps: Array<{ id: Step; label: string; enabled: boolean }> = [
    { id: 'profile', label: '1. Master profile', enabled: true },
    { id: 'job', label: '2. Job posting', enabled: hasProfile },
    { id: 'review', label: '3. Review changes', enabled: hasRun },
    { id: 'export', label: '4. Export', enabled: hasRun },
  ];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-bold tracking-tight">Sartor</h1>
          <p className="text-sm text-stone-500">
            Your resume and your key stay in this browser. There is no server to send them to.
          </p>
        </div>
      </header>

      <nav className="mb-6 flex flex-wrap gap-1 border-b border-stone-300">
        {steps.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={!s.enabled}
            onClick={() => setStep(s.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:text-stone-300 ${
              step === s.id
                ? 'border-ink text-ink'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setStep('profile')}
          className="ml-auto px-3 py-2 text-sm text-stone-400"
          aria-hidden
          tabIndex={-1}
        />
      </nav>

      <div className="space-y-6">
        <KeyPanel />

        {step === 'profile' && <ProfileStep onDone={() => setStep('job')} />}
        {step === 'job' && (
          <JobStep
            keyReady={keyReady}
            onDone={() => setStep('review')}
          />
        )}
        {step === 'review' && <ReviewStep onDone={() => setStep('export')} />}
        {step === 'export' && <ExportStep />}
      </div>

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProfileStep({ onDone }: { onDone(): void }) {
  const { profile, profiles, upsertProfile, selectProfile, removeProfile } = useStore();
  const [draft, setDraft] = useState<Profile | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // A freshly parsed profile lives here, unsaved, until it is confirmed.
  const editing = draft ?? profile;

  if (!editing) {
    return (
      <ImportPanel
        onParsed={(p, w) => {
          setDraft(p);
          setWarnings(w);
        }}
        onBlank={(p) => {
          setDraft(p);
          setWarnings([]);
        }}
      />
    );
  }

  const isUnsaved = draft !== null;

  return (
    <div className="space-y-4">
      {profiles.length > 1 && !isUnsaved && (
        <div className="card flex flex-wrap items-center gap-2 p-3">
          <span className="label mb-0">Profile</span>
          <select
            className="field max-w-xs"
            value={profile?.id ?? ''}
            onChange={(e) => void selectProfile(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {isUnsaved && (
        <div className="rounded-lg border border-sky-300 bg-sky-50 p-4">
          <h2 className="text-sm font-semibold text-sky-900">Confirm before saving</h2>
          <p className="mt-1 text-sm text-sky-900">
            Nothing has been saved yet. Read through the fields below and fix anything that came
            across wrong — every resume you tailor is built from this.
          </p>
        </div>
      )}

      <ProfileEditor profile={editing} onChange={(p) => setDraft(p)} warnings={warnings} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await upsertProfile(editing);
            setDraft(null);
            setWarnings([]);
            setSaving(false);
            onDone();
          }}
        >
          {isUnsaved ? 'Save profile and continue' : 'Save changes and continue'}
        </button>
        {isUnsaved && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setDraft(null);
              setWarnings([]);
            }}
          >
            Discard
          </button>
        )}
        {!isUnsaved && profile && (
          <button
            type="button"
            className="btn-ghost ml-auto text-red-700"
            onClick={() => {
              if (confirm(`Delete "${profile.label}" and its history? This cannot be undone.`)) {
                void removeProfile(profile.id);
              }
            }}
          >
            Delete this profile
          </button>
        )}
      </div>
    </div>
  );
}

function JobStep({ keyReady, onDone }: { keyReady: boolean; onDone(): void }) {
  const { profile, setRun } = useStore();
  const { provider, config } = useActiveProvider();
  const [jd, setJd] = useState<JobDescription | null>(null);
  const [constraints, setConstraints] = useState<TailorConstraints>(DEFAULT_CONSTRAINTS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);

  async function run() {
    if (!profile || !jd) return;
    setRunning(true);
    setError(null);
    setDropped([]);
    try {
      const outcome = await runTailor(profile, jd, constraints, provider, config);
      setRun(outcome.run);
      setDropped(outcome.dropped);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <JobPanel
        jd={jd}
        onJd={setJd}
        constraints={constraints}
        onConstraints={setConstraints}
        onRun={() => void run()}
        running={running}
        canRun={keyReady && profile !== null}
      />
      {!keyReady && (
        <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          Add an API key above to run the tailoring call.
        </p>
      )}
      {dropped.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Discarded {dropped.length} element(s)</strong> that pointed at nothing in your
          profile: {dropped.join(' ')}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}
    </div>
  );
}

function ReviewStep({ onDone }: { onDone(): void }) {
  const { run, updateChange, commitRun } = useStore();
  if (!run) return null;

  return (
    <div className="space-y-4">
      <ReviewPanel run={run} onChange={updateChange} />
      <button
        type="button"
        className="btn-primary"
        onClick={async () => {
          await commitRun();
          onDone();
        }}
      >
        Continue to export
      </button>
      <p className="text-xs text-stone-500">
        Accepted rephrasings are saved back onto your master profile as alternate wordings of the
        same fact. Your original text is never overwritten.
      </p>
    </div>
  );
}

function ExportStep() {
  const { profile, run, settings, updateSettings } = useStore();

  const doc = useMemo(
    () => (profile && run ? buildDocument(profile, run.plan, run.changes) : null),
    [profile, run],
  );

  const coverage = useMemo(
    () => (doc && profile && run ? buildCoverage(run.jd.text, documentToSlices(doc), profile) : null),
    [doc, profile, run],
  );

  if (!profile || !run || !doc || !coverage) return null;

  const fileBase = [profile.basics.name || 'resume', run.jd.company || run.jd.title]
    .filter(Boolean)
    .join(' — ')
    .replace(/[^\w\s—-]/g, '')
    .trim();

  return (
    <ExportPanel
      doc={doc}
      coverage={coverage}
      blocking={blockingChanges(run.changes)}
      templateId={settings.templateId}
      onTemplate={(id) => void updateSettings({ templateId: id })}
      pageTarget={run.constraints.pageTarget}
      fileBase={fileBase || 'resume'}
    />
  );
}

function Footer() {
  const { eraseEverything } = useStore();
  return (
    <footer className="mt-12 border-t border-stone-200 pt-6 text-xs text-stone-500">
      <p>
        Everything you see is stored in this browser: profiles and history in IndexedDB, your API key
        in this tab's sessionStorage. Nothing is uploaded anywhere except the model calls you
        trigger, which go directly to the provider you chose.
      </p>
      <button
        type="button"
        className="mt-2 text-red-700 underline"
        onClick={() => {
          if (confirm('Erase every profile, run, and setting stored in this browser?')) {
            void eraseEverything();
          }
        }}
      >
        Erase all local data
      </button>
    </footer>
  );
}
