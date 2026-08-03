import { useState } from 'react';
import { saveAs } from 'file-saver';
import { renderTextBlob, type ResumeDocument, type Template } from '../../index';
import type { ExportRecord } from '../../storage/db';

/**
 * Every document this browser has produced, newest first.
 *
 * The question this answers is the one you cannot answer from a Downloads
 * folder six months later: which version of my resume did that company get?
 * Each record carries its own copy of the document and the template, so it
 * re-renders exactly as it was even after the master profile has moved on.
 *
 * Nothing here leaves the machine. These are the same IndexedDB guarantees as
 * profiles and runs: no account, no sync, and "Erase all local data" takes them
 * with everything else.
 */
export function ExportHistoryPanel({
  records,
  onDelete,
}: {
  records: ExportRecord[];
  onDelete(id: string): void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (records.length === 0) return null;

  async function download(record: ExportRecord, kind: 'pdf' | 'docx' | 'txt') {
    setBusy(`${record.id}:${kind}`);
    setError(null);
    try {
      const doc: ResumeDocument = record.doc;
      const template: Template = record.template;
      const blob =
        kind === 'pdf'
          ? await (await import('../../render/pdf')).renderPdfBlob(doc, template)
          : kind === 'docx'
            ? await (await import('../../render/docx')).renderDocxBlob(doc, template)
            : renderTextBlob(doc);
      saveAs(blob, `${record.fileBase}.${kind}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Saved exports</h2>
      <p className="mt-1 text-sm text-stone-600">
        Kept in this browser so you can see what you sent and when. Each one holds its own copy of
        the document, so editing your profile never changes a record of something already sent.
      </p>

      <ul className="mt-3 divide-y divide-stone-200">
        {records.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{r.label}</p>
              <p className="text-xs text-stone-500">
                {new Date(r.createdAt).toLocaleString()} · {r.template.label} ·{' '}
                {r.formats.join(', ').toUpperCase()}
                {r.runId === null && (
                  <span className="ml-1.5 rounded bg-stone-200 px-1.5 py-0.5 text-stone-700">
                    master profile
                  </span>
                )}
              </p>
            </div>
            {(['pdf', 'docx', 'txt'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn-secondary"
                disabled={busy !== null}
                onClick={() => void download(r, kind)}
              >
                {busy === `${r.id}:${kind}` ? '…' : kind.toUpperCase()}
              </button>
            ))}
            <button
              type="button"
              className="btn-ghost text-red-700"
              aria-label={`Delete the export ${r.label}`}
              onClick={() => onDelete(r.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          {error}
        </div>
      )}
    </div>
  );
}
