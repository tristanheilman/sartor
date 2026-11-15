import { useMemo, useState } from 'react';
import {
  applyMerge,
  summarizeMerge,
  type BasicsChange,
  type BulletCandidate,
  type EntryCandidate,
  type FieldChange,
  type MergeAction,
  type MergeSection,
  type ProfileMerge,
} from '../../parse';
import type { Award, Certificate, Education, Profile, Project, SkillGroup, Work } from '../../index';

/**
 * Where a GitHub-proposed bullet came from. Structurally the same as core's
 * `BulletProvenance`; declared here because the app reaches core only through
 * published entry points.
 */
export interface BulletProvenance {
  repo: string;
  artifact: 'readme' | 'manifest' | 'commits';
  ref: string;
  url: string;
  impact: 'blank';
}

/**
 * The merge confirmation screen: what `planMerge` proposes, shown for a
 * decision before anything is applied.
 *
 * Every candidate defaults to its `suggested` action, which the person can
 * override per entry, per bullet, per date and per basics field — the same
 * propose/confirm/apply shape as the ingest screen this is modelled on.
 * Nothing here touches the profile; `onCommit` only fires once, with the
 * result of `applyMerge`.
 */
export function MergePanel({
  base,
  plan,
  sourceLabel,
  provenance,
  onCommit,
  onCancel,
}: {
  base: Profile;
  plan: ProfileMerge;
  sourceLabel?: string;
  /**
   * Where GitHub-proposed bullets came from, keyed by bullet ID. Display-only:
   * it is never written to the profile.
   */
  provenance?: Record<string, BulletProvenance>;
  onCommit(next: Profile): void;
  onCancel(): void;
}) {
  // Impact the person typed for a GitHub bullet, by candidate key. Blank unless
  // they write something; nothing is ever filled in for them.
  const [impacts, setImpacts] = useState<Record<string, string>>({});

  const fromGitHub = useMemo(() => {
    if (!provenance) return 0;
    let n = 0;
    for (const { key } of SECTION_META) {
      for (const c of plan[key] as EntryCandidate<unknown>[]) {
        for (const b of c.bullets) if (provenance[b.incoming.id]) n++;
      }
    }
    return n;
  }, [plan, provenance]);

  const commit = () => {
    const typed = Object.entries(impacts).filter(([, v]) => v.trim());
    let toApply = plan;
    if (typed.length > 0) {
      const byKey = new Map(typed.map(([k, v]) => [k, v.trim()]));
      const next: Record<string, unknown> = { ...plan };
      for (const { key } of SECTION_META) {
        next[key] = (plan[key] as EntryCandidate<unknown>[]).map((c) => ({
          ...c,
          bullets: c.bullets.map((b) => {
            const extra = byKey.get(b.key);
            return extra
              ? { ...b, incoming: { ...b.incoming, text: `${b.incoming.text.trim()} ${extra}` } }
              : b;
          }),
        }));
      }
      toApply = next as unknown as ProfileMerge;
    }
    onCommit(applyMerge(base, toApply, { decisions, sourceLabel }));
  };

  const [decisions, setDecisions] = useState<Record<string, MergeAction>>({});
  const setDecision = (key: string, action: MergeAction) =>
    setDecisions((prev) => ({ ...prev, [key]: action }));

  const summary = useMemo(() => summarizeMerge(plan, decisions), [plan, decisions]);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-base font-semibold">
          Review before merging{sourceLabel ? ` "${sourceLabel}"` : ''}
        </h2>
        <p className="mt-1 text-sm text-stone-600" role="status">
          {summary.newEntries} new entr{summary.newEntries === 1 ? 'y' : 'ies'} ·{' '}
          {summary.mergedEntries} merged · {summary.newBullets} new bullet
          {summary.newBullets === 1 ? '' : 's'} · {summary.newVariants} reworded · {summary.datesCorrected}{' '}
          date{summary.datesCorrected === 1 ? '' : 's'} corrected
          {summary.basicsChanged > 0 &&
            ` · ${summary.basicsChanged} basics field${summary.basicsChanged === 1 ? '' : 's'}`}{' '}
          · {summary.skipped} skipped
          {fromGitHub > 0 && ` · ${fromGitHub} from GitHub`}
        </p>
      </div>

      {plan.basics.length > 0 && (
        <section className="card p-5">
          <h3 className="text-sm font-semibold text-stone-500">Basics</h3>
          <div className="mt-3 space-y-2">
            {plan.basics.map((change) => (
              <BasicsRow
                key={change.key}
                change={change}
                value={decisions[change.key] ?? change.suggested}
                onChange={(a) => setDecision(change.key, a)}
              />
            ))}
          </div>
        </section>
      )}

      {SECTION_META.map(({ key, title }) => {
        const candidates = plan[key];
        if (candidates.length === 0) return null;

        return (
          <section key={key} className="card p-5">
            <h3 className="text-sm font-semibold text-stone-500">{title}</h3>
            <div className="mt-3 space-y-4">
              {candidates.map((candidate) => (
                <EntryRow
                  key={candidate.key}
                  section={key}
                  candidate={candidate as EntryCandidate<unknown>}
                  decisions={decisions}
                  onDecision={setDecision}
                  provenance={provenance}
                  impacts={impacts}
                  onImpact={(k, v) => setImpacts((prev) => ({ ...prev, [k]: v }))}
                />
              ))}
            </div>
          </section>
        );
      })}

      <div className="flex gap-2">
        <button
          type="button"
          className="btn-primary"
          onClick={commit}
        >
          Commit merge
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const SECTION_META: ReadonlyArray<{ key: MergeSection; title: string }> = [
  { key: 'work', title: 'Work experience' },
  { key: 'projects', title: 'Projects' },
  { key: 'education', title: 'Education' },
  { key: 'skills', title: 'Skills' },
  { key: 'certificates', title: 'Certificates' },
  { key: 'awards', title: 'Awards' },
  { key: 'languages', title: 'Languages' },
];

function entryTitle(section: MergeSection, incoming: unknown): string {
  switch (section) {
    case 'work': {
      const w = incoming as Work;
      return [w.position, w.name].filter(Boolean).join(' · ') || 'Untitled role';
    }
    case 'projects':
      return (incoming as Project).name || 'Untitled project';
    case 'education': {
      const e = incoming as Education;
      return [e.studyType, e.institution].filter(Boolean).join(' · ') || 'Untitled program';
    }
    case 'skills':
      return (incoming as SkillGroup).name || 'Untitled skill group';
    case 'certificates':
      return (incoming as Certificate).name || 'Untitled certificate';
    case 'awards':
      return (incoming as Award).title || 'Untitled award';
    case 'languages':
      return (incoming as { language: string }).language || 'Untitled language';
  }
}

/** `add` / `merge into…` (only when there is something to merge into) / `skip`. */
function ActionButtons({
  value,
  onChange,
  mergeLabel,
}: {
  value: MergeAction;
  onChange(action: MergeAction): void;
  mergeLabel?: string;
}) {
  const options: Array<{ id: MergeAction; label: string }> = [
    { id: 'add', label: 'Add' },
    ...(mergeLabel ? [{ id: 'merge' as const, label: mergeLabel }] : []),
    { id: 'skip', label: 'Skip' },
  ];

  return (
    <div className="flex shrink-0 gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
            value === o.id
              ? 'border-stone-800 bg-stone-800 text-white'
              : 'border-stone-300 bg-white text-stone-700 hover:border-stone-400'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EntryRow({
  section,
  candidate,
  decisions,
  onDecision,
  provenance,
  impacts,
  onImpact,
}: {
  section: MergeSection;
  candidate: EntryCandidate<unknown>;
  decisions: Record<string, MergeAction>;
  onDecision(key: string, action: MergeAction): void;
  provenance?: Record<string, BulletProvenance>;
  impacts: Record<string, string>;
  onImpact(key: string, value: string): void;
}) {
  const value = decisions[candidate.key] ?? candidate.suggested;

  return (
    <article className="rounded-md border border-stone-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{entryTitle(section, candidate.incoming)}</p>
          {candidate.match && <p className="mt-0.5 text-xs text-stone-500">{candidate.match.reason}</p>}
        </div>
        <ActionButtons
          value={value}
          onChange={(a) => onDecision(candidate.key, a)}
          mergeLabel={candidate.match ? 'Merge into…' : undefined}
        />
      </div>

      {candidate.fields.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-stone-100 pt-3">
          {candidate.fields.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              value={decisions[field.key] ?? field.suggested}
              onChange={(a) => onDecision(field.key, a)}
            />
          ))}
        </ul>
      )}

      {candidate.bullets.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-stone-100 pt-3">
          {candidate.bullets.map((bullet) => (
            <BulletRow
              key={bullet.key}
              bullet={bullet}
              value={decisions[bullet.key] ?? bullet.suggested}
              onChange={(a) => onDecision(bullet.key, a)}
              provenance={provenance?.[bullet.incoming.id]}
              impact={impacts[bullet.key] ?? ''}
              onImpact={(v) => onImpact(bullet.key, v)}
            />
          ))}
        </ul>
      )}
    </article>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: FieldChange;
  value: MergeAction;
  onChange(action: MergeAction): void;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div>
        <span className="font-medium">{field.label}</span>
        <span className="ml-2 text-stone-500">
          {field.current} → {field.incoming}
        </span>
        <p className="text-xs text-stone-500">{field.reason}</p>
      </div>
      <ActionButtons value={value} onChange={onChange} />
    </li>
  );
}

const ARTIFACT_LABEL: Record<BulletProvenance['artifact'], string> = {
  readme: 'README',
  manifest: 'Manifest',
  commits: 'Commits',
};

function BulletRow({
  bullet,
  value,
  onChange,
  provenance,
  impact,
  onImpact,
}: {
  bullet: BulletCandidate;
  value: MergeAction;
  onChange(action: MergeAction): void;
  provenance?: BulletProvenance;
  impact: string;
  onImpact(value: string): void;
}) {
  // A bullet only has something to merge *into* when it is a reworded
  // version of one already on this entry — `planMerge`'s own signal for that
  // is `suggested: 'merge'`. A word-for-word repeat gets `duplicateOf` too,
  // but offering "Merge into…" there would imply there is a new phrasing to
  // keep when there is not, so it only gets Add / Skip.
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 text-sm">
      <div className="flex-1">
        <p>{bullet.incoming.text}</p>
        <p className="mt-0.5 text-xs text-stone-500">{bullet.reason}</p>
        {provenance && (
          <div className="mt-1 text-xs text-stone-500" data-testid="provenance">
            <span>{provenance.repo}</span> · <span>{ARTIFACT_LABEL[provenance.artifact]}</span>
            {provenance.ref && <span> ({provenance.ref})</span>} ·{' '}
            <a href={provenance.url} target="_blank" rel="noopener noreferrer" className="underline">
              View source
            </a>
            {provenance.impact === 'blank' && (
              <div className="mt-1">
                <label className="text-amber-700">
                  Add your own impact — no number or outcome is in the repository
                  <input
                    type="text"
                    value={impact}
                    onChange={(e) => onImpact(e.target.value)}
                    placeholder="Your own number or wording (optional)"
                    className="mt-0.5 block w-full rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-800"
                  />
                </label>
              </div>
            )}
          </div>
        )}
      </div>
      <ActionButtons
        value={value}
        onChange={onChange}
        mergeLabel={bullet.suggested === 'merge' ? 'Merge into…' : undefined}
      />
    </li>
  );
}

function BasicsRow({
  change,
  value,
  onChange,
}: {
  change: BasicsChange;
  value: MergeAction;
  onChange(action: MergeAction): void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div>
        <span className="font-medium">{change.label}</span>
        <span className="ml-2 text-stone-500">
          {change.current || '(blank)'} → {change.incoming}
        </span>
      </div>
      <ActionButtons value={value} onChange={onChange} mergeLabel={undefined} />
    </div>
  );
}
