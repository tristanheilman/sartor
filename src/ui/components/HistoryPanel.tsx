import type { TailorRun } from '@/core/tailor/apply';
import { blockingChanges, reviewProgress } from '@/core/tailor/apply';

/**
 * Past tailoring runs for the active profile.
 *
 * Runs are stored alongside profiles in IndexedDB, so reopening one is a local
 * read — no second model call, and no cost. That matters because the most
 * common real-world need is "send that same resume to a similar posting", and
 * regenerating it would be both slower and non-deterministic.
 */
export function HistoryPanel({
  runs,
  currentRunId,
  onOpen,
  onDelete,
}: {
  runs: TailorRun[];
  currentRunId: string | null;
  onOpen(id: string): void;
  onDelete(id: string): void;
}) {
  if (runs.length === 0) return null;

  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Previous runs</h2>
      <p className="mt-1 text-sm text-stone-600">
        Stored in this browser. Reopening one costs nothing — it does not call the model again.
      </p>

      <ul className="mt-3 divide-y divide-stone-200">
        {runs.map((r) => {
          const progress = reviewProgress(r.changes);
          const blocked = blockingChanges(r.changes).length;
          const isCurrent = r.id === currentRunId;

          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {r.jd.title || 'Untitled posting'}
                  {r.jd.company ? ` · ${r.jd.company}` : ''}
                </p>
                <p className="text-xs text-stone-500">
                  {new Date(r.createdAt).toLocaleString()} · {r.model} ·{' '}
                  {progress.reviewed}/{progress.total} reviewed
                  {blocked > 0 && (
                    <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-red-900">
                      {blocked} unresolved
                    </span>
                  )}
                  {isCurrent && (
                    <span className="ml-1.5 rounded bg-stone-200 px-1.5 py-0.5 text-stone-700">
                      open
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary"
                disabled={isCurrent}
                onClick={() => onOpen(r.id)}
              >
                {isCurrent ? 'Open' : 'Reopen'}
              </button>
              <button
                type="button"
                className="btn-ghost text-red-700"
                aria-label={`Delete run for ${r.jd.title || 'untitled posting'}`}
                onClick={() => onDelete(r.id)}
              >
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
