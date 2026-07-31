import { useRef, useState } from 'react';
import { extractResumeText, ExtractionError } from '../../core/parse/extract';
import { ingestResume } from '../../core/parse/ingest';
import { emptyProfile } from '../../core/schema';
import type { Profile } from '../../core/schema';
import { ids } from '../../core/ids';
import { useActiveProvider } from '../store';

type Phase = 'idle' | 'extracting' | 'structuring' | 'error';

/**
 * Resume ingestion.
 *
 * The parsed result is handed to the caller for confirmation, never saved
 * directly — see the note in `core/parse/ingest.ts` for why that matters.
 */
export function ImportPanel({
  onParsed,
  onBlank,
}: {
  onParsed(profile: Profile, warnings: string[]): void;
  onBlank(profile: Profile): void;
}) {
  const { provider, config, ready } = useActiveProvider();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase === 'extracting' || phase === 'structuring';

  async function structure(text: string, label: string) {
    setPhase('structuring');
    setError(null);
    try {
      const { profile, warnings } = await ingestResume(text, provider, config, { label });
      setPhase('idle');
      onParsed(profile, warnings);
    } catch (err) {
      setPhase('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleFile(file: File) {
    setPhase('extracting');
    setError(null);
    try {
      // Vite-specific: `?url` makes the worker a first-party asset in our own
      // bundle. The library takes this as a parameter precisely so that this
      // bundler-specific line lives here, in application code, and not in
      // something we publish.
      const { default: pdfWorkerSrc } = await import(
        'pdfjs-dist/build/pdf.worker.min.mjs?url'
      );
      const extracted = await extractResumeText(file, { pdfWorkerSrc });
      await structure(extracted.text, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setPhase('error');
      setError(
        err instanceof ExtractionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-base font-semibold">Start from an existing resume</h2>
        <p className="mt-1 text-sm text-stone-600">
          The file is read in this browser tab. Only the extracted text is sent to{' '}
          {provider.info.label}, and only so it can be turned into structured fields you then review.
        </p>

        <div
          className="mt-4 rounded-lg border-2 border-dashed border-stone-300 p-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) void handleFile(file);
          }}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <p className="text-sm text-stone-600">Drop a PDF, DOCX, or text file here</p>
          <button
            type="button"
            className="btn-secondary mt-3"
            disabled={!ready || busy}
            onClick={() => fileInput.current?.click()}
          >
            Choose a file
          </button>
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-stone-700">
            Or paste the text instead
          </summary>
          <textarea
            className="field mt-2 font-mono text-xs"
            rows={8}
            placeholder="Paste your whole resume here."
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button
            type="button"
            className="btn-primary mt-2"
            disabled={!ready || busy || pasted.trim().length < 40}
            onClick={() => void structure(pasted, 'Pasted resume')}
          >
            Parse pasted text
          </button>
        </details>

        {!ready && (
          <p className="mt-3 rounded-md bg-amber-50 p-2.5 text-sm text-amber-900">
            Add an API key above first — parsing a resume into structured fields takes one model
            call.
          </p>
        )}

        {busy && (
          <p className="mt-3 text-sm text-stone-600" role="status">
            {phase === 'extracting' ? 'Reading the file…' : 'Structuring the content…'}
          </p>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        )}
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold">Or start from nothing</h2>
        <p className="mt-1 text-sm text-stone-600">
          Build the profile by hand. Slower, but nothing is guessed.
        </p>
        <button
          type="button"
          className="btn-secondary mt-3"
          onClick={() => onBlank({ ...emptyProfile(ids.profile()), label: 'My profile' })}
        >
          Create an empty profile
        </button>
      </div>
    </div>
  );
}
