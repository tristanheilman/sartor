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
  onCommit,
  onCancel,
}: {
  base: Profile;
  plan: ProfileMerge;
  sourceLabel?: string;
  onCommit(next: Profile): void;
  onCancel(): void;
}) {
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
          onClick={() => onCommit(applyMerge(base, plan, { decisions, sourceLabel }))}
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
}: {
  section: MergeSection;
  candidate: EntryCandidate<unknown>;
  decisions: Record<string, MergeAction>;
  onDecision(key: string, action: MergeAction): void;
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

function BulletRow({
  bullet,
  value,
  onChange,
}: {
  bullet: BulletCandidate;
  value: MergeAction;
  onChange(action: MergeAction): void;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 text-sm">
      <div className="flex-1">
        <p>{bullet.incoming.text}</p>
        <p className="mt-0.5 text-xs text-stone-500">
          {bullet.duplicateOf ? 'Becomes an alternate wording of an existing bullet' : bullet.reason}
        </p>
      </div>
      <ActionButtons
        value={value}
        onChange={onChange}
        mergeLabel={bullet.duplicateOf ? 'Merge into…' : undefined}
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
