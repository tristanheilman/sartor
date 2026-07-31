import { useMemo } from 'react';
import type { Change, TailorRun } from '@/core/tailor/apply';
import { blockingChanges, reviewProgress } from '@/core/tailor/apply';
import type { Violation } from '@/core/tailor/guard';
import { diffWords } from '../diff';

/**
 * Diff review.
 *
 * Every change is shown individually with its provenance and its rationale, and
 * accepted or rejected on its own. Rejecting one reverts that one line to the
 * master-profile original; nothing is regenerated and nothing else moves.
 */
export function ReviewPanel({
  run,
  onChange,
}: {
  run: TailorRun;
  onChange(id: string, patch: Partial<Change>): void;
}) {
  const progress = reviewProgress(run.changes);
  const blocking = blockingChanges(run.changes);

  const grouped = useMemo(() => {
    const map = new Map<string, Change[]>();
    for (const c of run.changes) {
      const list = map.get(c.label) ?? [];
      list.push(c);
      map.set(c.label, list);
    }
    return [...map.entries()];
  }, [run.changes]);

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Review every change</h2>
            <p className="mt-1 text-sm text-stone-600">
              {progress.reviewed} of {progress.total} reviewed. Rejecting a change restores your
              original wording — nothing is regenerated.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => run.changes.forEach((c) => onChange(c.id, { status: 'accepted', reviewed: true }))}
            >
              Accept all
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => run.changes.forEach((c) => onChange(c.id, { status: 'rejected', reviewed: true }))}
            >
              Reject all
            </button>
          </div>
        </div>

        {blocking.length > 0 && (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3">
            <h3 className="text-sm font-semibold text-red-900">
              {blocking.length} change{blocking.length === 1 ? '' : 's'} contain content that is not
              in your profile
            </h3>
            <p className="mt-1 text-sm text-red-800">
              Export is blocked until each one is either rejected or confirmed as yours. This is the
              check that stops a model from quietly adding a skill or a number you never had.
            </p>
          </div>
        )}

        {run.notes.trim() && (
          <div className="mt-4 rounded-md border border-stone-300 bg-stone-50 p-3">
            <h3 className="text-sm font-semibold">What the posting asked for that you do not have</h3>
            <p className="mt-1 text-sm whitespace-pre-line text-stone-700">{run.notes}</p>
          </div>
        )}
      </div>

      {grouped.map(([label, changes]) => (
        <section key={label} className="card p-5">
          <h3 className="text-sm font-semibold text-stone-500">{label}</h3>
          <div className="mt-3 space-y-4">
            {changes.map((c) => (
              <ChangeCard key={c.id} change={c} onChange={onChange} />
            ))}
          </div>
        </section>
      ))}

      {run.changes.length === 0 && (
        <div className="card p-5 text-sm text-stone-600">
          The model did not propose any changes. Your profile already reads the way it would have
          written it for this posting.
        </div>
      )}
    </div>
  );
}

const KIND_LABEL: Record<Change['kind'], string> = {
  summary: 'Summary rewritten',
  'bullet-text': 'Rephrased',
  'bullet-drop': 'Dropped',
  'entry-drop': 'Role dropped',
  skills: 'Skills filtered',
  'section-order': 'Sections reordered',
};

function ChangeCard({
  change,
  onChange,
}: {
  change: Change;
  onChange(id: string, patch: Partial<Change>): void;
}) {
  const unacknowledged = change.violations.filter((v) => !change.acknowledged.includes(v.id));
  const blocked = change.status === 'accepted' && unacknowledged.length > 0;
  const isRemoval = change.after === '';

  return (
    <article
      className={`rounded-md border p-3 ${
        blocked
          ? 'border-red-300 bg-red-50/50'
          : change.status === 'rejected'
            ? 'border-stone-200 bg-stone-50'
            : 'border-stone-200'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-stone-200 px-1.5 py-0.5 text-xs font-medium text-stone-700">
          {KIND_LABEL[change.kind]}
        </span>
        {!change.reviewed && (
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800">Not reviewed</span>
        )}
        {change.status === 'rejected' && (
          <span className="rounded bg-stone-300 px-1.5 py-0.5 text-xs text-stone-800">
            Rejected — your original is used
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          <button
            type="button"
            className={change.status === 'accepted' && change.reviewed ? 'btn-primary' : 'btn-secondary'}
            onClick={() => onChange(change.id, { status: 'accepted', reviewed: true })}
          >
            Accept
          </button>
          <button
            type="button"
            className={change.status === 'rejected' ? 'btn-primary' : 'btn-secondary'}
            onClick={() => onChange(change.id, { status: 'rejected', reviewed: true })}
          >
            Reject
          </button>
        </div>
      </div>

      <div className="mt-3 text-sm">
        {isRemoval ? (
          <p className="text-stone-500 line-through">{change.before}</p>
        ) : change.before ? (
          <p className="leading-relaxed">
            {diffWords(change.before, change.after).map((op, i) => (
              <span
                key={i}
                className={
                  op.type === 'add'
                    ? 'rounded bg-emerald-100 text-emerald-900'
                    : op.type === 'remove'
                      ? 'rounded bg-red-100 text-red-900 line-through'
                      : ''
                }
              >
                {op.text}
              </span>
            ))}
          </p>
        ) : (
          <p className="rounded bg-emerald-100 px-1 leading-relaxed text-emerald-900">{change.after}</p>
        )}
      </div>

      {change.rationale && (
        <p className="mt-2 text-xs text-stone-500">Why: {change.rationale}</p>
      )}

      {change.violations.length > 0 && (
        <ul className="mt-3 space-y-2">
          {change.violations.map((v) => (
            <ViolationRow
              key={v.id}
              violation={v}
              acknowledged={change.acknowledged.includes(v.id)}
              onToggle={(ack) =>
                onChange(change.id, {
                  acknowledged: ack
                    ? [...change.acknowledged, v.id]
                    : change.acknowledged.filter((id) => id !== v.id),
                })
              }
            />
          ))}
        </ul>
      )}
    </article>
  );
}

function ViolationRow({
  violation,
  acknowledged,
  onToggle,
}: {
  violation: Violation;
  acknowledged: boolean;
  onToggle(ack: boolean): void;
}) {
  return (
    <li
      className={`rounded border p-2.5 text-sm ${
        acknowledged ? 'border-stone-300 bg-white' : 'border-red-300 bg-white'
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 rounded px-1.5 py-0.5 text-xs font-medium ${
            violation.severity === 'high'
              ? 'bg-red-200 text-red-900'
              : 'bg-amber-200 text-amber-900'
          }`}
        >
          {violation.severity === 'high' ? 'Not in profile' : 'Unverified'}
        </span>
        <p className="flex-1 text-stone-800">{violation.message}</p>
      </div>
      <label className="mt-2 flex cursor-pointer items-start gap-2 text-xs text-stone-600">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={acknowledged}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          This is genuinely mine — the profile just does not mention it yet. Add it to your profile so
          future runs recognise it.
        </span>
      </label>
    </li>
  );
}
