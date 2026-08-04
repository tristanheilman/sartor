import { useMemo, useState } from 'react';
import { StoreProvider, useStore, useActiveProvider } from './store';
import { ProfileEditor } from './components/ProfileEditor';
import { Aurora } from './components/Aurora';
import { SettingsButton } from './components/SettingsButton';
import { ImportPanel } from './components/ImportPanel';
import { InterviewPanel } from './components/InterviewPanel';
import { JobPanel } from './components/JobPanel';
import { ReviewPanel } from './components/ReviewPanel';
import { ExportPanel } from './components/ExportPanel';
import { ExportHistoryPanel } from './components/ExportHistoryPanel';
import { HistoryPanel } from './components/HistoryPanel';
import {
  DEFAULT_CONSTRAINTS,
  TEMPLATES,
  blockingChanges,
  buildCoverage,
  buildDocument,
  documentToSlices,
  identityPlan,
  runTailor,
  type JobDescription,
  type Profile,
  type TailorConstraints,
} from '../index';

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

  if (store.failure) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <Aurora />
        <div className="card p-5">
          <h2 className="text-base font-semibold">Cannot open your local data</h2>
          <p className="mt-2 text-sm text-stone-600">{store.failure}</p>
          <button type="button" className="btn-primary mt-4" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (!store.ready) {
    return <div className="p-10 text-sm text-stone-500">Loading your local data…</div>;
  }

  const hasProfile = store.profile !== null;
  const hasRun = store.run !== null;

  const steps: Array<{ id: Step; label: string; enabled: boolean }> = [
    { id: 'profile', label: 'Profile', enabled: true },
    { id: 'job', label: 'Job posting', enabled: hasProfile },
    { id: 'review', label: 'Review', enabled: hasRun },
    // Export needs a profile, not a run. Without a run it prints the master
    // profile as it stands, which is the whole point of keeping one.
    { id: 'export', label: 'Export', enabled: hasProfile },
  ];

  // Deleting a profile or erasing all data can pull the ground out from under
  // the step the user is standing on. Fall back rather than leaving them on a
  // screen the nav has just disabled — derived, not an effect, so there is no
  // frame where the stale step is still painted.
  const activeStep: Step = steps.find((s) => s.id === step)?.enabled ? step : 'profile';

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Aurora />
      <header className="mb-7 flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Sartor</h1>
        <SettingsButton />
      </header>

      {/* Nothing to navigate to until there is a profile, so the row stays out
          of the way until it means something. */}
      {hasProfile && (
        <nav className="mb-7 flex flex-wrap items-center gap-x-5 gap-y-2">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              disabled={!s.enabled}
              onClick={() => setStep(s.id)}
              className={`text-sm transition-colors disabled:cursor-not-allowed disabled:text-stone-300 ${
                activeStep === s.id ? 'font-medium text-ink' : 'text-stone-500 hover:text-stone-800'
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      )}

      <div className="space-y-6">

        {activeStep === 'profile' && <ProfileStep onDone={() => setStep('job')} />}
        {activeStep === 'job' && (
          <JobStep
            keyReady={keyReady}
            onDone={() => setStep('review')}
          />
        )}
        {activeStep === 'review' && <ReviewStep onDone={() => setStep('export')} />}
        {activeStep === 'export' && <ExportStep />}
      </div>

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ProfileStep({ onDone }: { onDone(): void }) {
  const { profile, profiles, upsertProfile, selectProfile, removeProfile, draft, saveDraft } =
    useStore();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // The interview runs against the draft, before anything is persisted, so a
  // person can see what their answers did and still walk away from all of it.
  const [interviewing, setInterviewing] = useState(false);

  // A freshly parsed profile lives here, unsaved, until it is confirmed.
  const editing = draft ?? profile;

  if (!editing) {
    return (
      <ImportPanel
        onParsed={(p, w) => {
          void saveDraft(p);
          setWarnings(w);
          // Straight into the questions: the gaps are most obvious, and most
          // worth filling, the moment a resume has been read.
          setInterviewing(true);
        }}
        onBlank={(p) => {
          void saveDraft(p);
          setWarnings([]);
        }}
      />
    );
  }

  // Two different states share this screen, and conflating them is misleading:
  // a profile that has never been persisted, and a saved profile with pending
  // edits. Only the first one warrants "nothing has been saved yet".
  const hasEdits = draft !== null;
  const isNew = hasEdits && !profiles.some((p) => p.id === editing.id);

  if (interviewing) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <InterviewPanel
          profile={editing}
          // Written through on every answer, so a reload picks up where the
          // conversation left off instead of throwing it away.
          onProfile={(next) => void saveDraft(next)}
          onDone={() => setInterviewing(false)}
        />
        {/* The profile as it stands, updating as each answer lands. Hidden on
            narrow screens, where the conversation is the whole screen. */}
        <aside className="hidden lg:block">
          <LiveProfile profile={editing} />
        </aside>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {profiles.length > 1 && !hasEdits && (
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

      {isNew && (
        <div className="rounded-lg border border-sky-300 bg-sky-50 p-4">
          <h2 className="text-sm font-semibold text-sky-900">Confirm before saving</h2>
          <p className="mt-1 text-sm text-sky-900">
            Nothing has been saved yet. Read through the fields below and fix anything that came
            across wrong — every resume you tailor is built from this.
          </p>
        </div>
      )}

      {hasEdits && !isNew && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            You have unsaved edits to this profile.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary" onClick={() => setInterviewing(true)}>
          Answer a few questions instead
        </button>
        <span className="text-sm text-stone-600">
          Faster than the form, and it only asks about what is missing.
        </span>
      </div>

      <ProfileEditor profile={editing} onChange={(p) => void saveDraft(p)} warnings={warnings} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await upsertProfile(editing);
            await saveDraft(null);
            setWarnings([]);
            setSaving(false);
            onDone();
          }}
        >
          {isNew ? 'Save profile and continue' : 'Save changes and continue'}
        </button>
        {hasEdits && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              void saveDraft(null);
              setWarnings([]);
            }}
          >
            Discard
          </button>
        )}
        {!hasEdits && profile && (
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
  const { profile, setRun, runs, run: currentRun, openRun, removeRun } = useStore();
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

      <HistoryPanel
        runs={runs}
        currentRunId={currentRun?.id ?? null}
        onOpen={(id) => {
          void openRun(id).then(onDone);
        }}
        onDelete={(id) => void removeRun(id)}
      />
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
  const { profile, run, settings, updateSettings, exports, recordExport, removeExport } = useStore();

  // No run means no tailoring: the identity plan renders the master profile
  // verbatim. Nothing was rewritten, so there is nothing to accept, nothing to
  // block on, and no posting to measure coverage against.
  const doc = useMemo(
    () =>
      profile ? buildDocument(profile, run ? run.plan : identityPlan(), run?.changes ?? []) : null,
    [profile, run],
  );

  const coverage = useMemo(
    () => (doc && profile && run ? buildCoverage(run.jd.text, documentToSlices(doc), profile) : null),
    [doc, profile, run],
  );

  if (!profile || !doc) return null;

  const fileBase = [profile.basics.name || 'resume', run ? run.jd.company || run.jd.title : '']
    .filter(Boolean)
    .join(' — ')
    .replace(/[^\w\s—-]/g, '')
    .trim();

  const templates = [...TEMPLATES, ...settings.customTemplates];

  // What this document was for, in the words the user will recognise later.
  const label = run
    ? [run.jd.title, run.jd.company].filter(Boolean).join(' · ') || 'Untitled posting'
    : 'Master profile';

  return (
    <>
    <ExportPanel
      doc={doc}
      coverage={coverage}
      blocking={run ? blockingChanges(run.changes) : []}
      templates={templates}
      templateId={settings.templateId}
      onTemplate={(id) => void updateSettings({ templateId: id })}
      onSaveTemplate={(t) => {
        const next = settings.customTemplates.filter((c) => c.id !== t.id);
        void updateSettings({ customTemplates: [...next, t] });
      }}
      onDeleteTemplate={(id) => {
        void updateSettings({
          customTemplates: settings.customTemplates.filter((c) => c.id !== id),
          // Deleting the selected template would otherwise leave the picker
          // pointing at nothing and the export silently falling back.
          ...(settings.templateId === id ? { templateId: TEMPLATES[0]!.id } : {}),
        });
      }}
      onExported={(formats, template) => {
        void recordExport({
          label,
          fileBase: fileBase || 'resume',
          formats,
          template,
          pageTarget: run ? run.constraints.pageTarget : settings.pageTarget,
          doc,
        });
      }}
      pageTarget={run ? run.constraints.pageTarget : settings.pageTarget}
      fileBase={fileBase || 'resume'}
    />
    <ExportHistoryPanel records={exports} onDelete={(id) => void removeExport(id)} />
    </>
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

/**
 * The profile as it stands, beside the conversation.
 *
 * Answering a question and seeing nothing change is the fastest way to stop
 * trusting a tool. This updates as each answer lands, so the effect of a reply
 * is visible in the same moment it is given.
 */
export function LiveProfile({ profile }: { profile: Profile }) {
  // Projects count too. The interview asks about them more than anything else,
  // and a total that ignores them sits unchanged while someone answers four
  // questions in a row — which reads as the answers having been thrown away.
  const bullets =
    profile.work.reduce((n, w) => n + w.bullets.length, 0) +
    profile.projects.reduce((n, p) => n + p.bullets.length, 0);

  return (
    <div className="card-glass sticky top-4 p-4">
      <h3 className="text-sm font-semibold">Your profile, live</h3>
      <p className="mt-1 font-mono text-xs text-stone-500">
        {profile.work.length} role{profile.work.length === 1 ? '' : 's'}
        {profile.projects.length > 0 &&
          ` · ${profile.projects.length} project${profile.projects.length === 1 ? '' : 's'}`}{' '}
        · {bullets} bullet
        {bullets === 1 ? '' : 's'} · {profile.skills.reduce((n, s) => n + s.keywords.length, 0)} skills
      </p>

      {profile.basics.summary && (
        <p className="mt-3 border-l-2 border-stone-300 pl-2 text-xs text-stone-600">
          {profile.basics.summary}
        </p>
      )}

      <div className="mt-3 flex max-h-[22rem] flex-col gap-3 overflow-y-auto">
        {profile.work.map((w) => (
          <div key={w.id}>
            <p className="text-xs font-semibold">{w.position || 'Untitled role'}</p>
            <p className="font-mono text-[11px] text-stone-500">
              {w.name}
              {w.startDate ? ` · ${w.startDate} — ${w.endDate || 'Present'}` : ''}
            </p>
            <ul className="mt-1 flex flex-col gap-1">
              {w.bullets.map((b) => (
                <li key={b.id} className="text-[11px] leading-snug text-stone-600">
                  · {b.text}
                </li>
              ))}
            </ul>
          </div>
        ))}

        {profile.projects.length > 0 && (
          <>
            <p className="mt-1 font-mono text-[10px] tracking-wide text-stone-400 uppercase">
              Projects
            </p>
            {profile.projects.map((p) => (
              <div key={p.id}>
                <p className="text-xs font-semibold">{p.name || 'Untitled project'}</p>
                {p.description && (
                  <p className="font-mono text-[11px] text-stone-500">{p.description}</p>
                )}
                <ul className="mt-1 flex flex-col gap-1">
                  {p.bullets.map((b) => (
                    <li key={b.id} className="text-[11px] leading-snug text-stone-600">
                      · {b.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
