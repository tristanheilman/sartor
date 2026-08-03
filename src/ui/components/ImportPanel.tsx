import { useRef, useState } from 'react';
import { ExtractionError, extractResumeText, ingestResume } from '../../parse';
import { emptyProfile, ids, type Profile } from '../../index';
import { useActiveProvider } from '../store';
import { LoadingScreen, type LoadingStep } from './LoadingScreen';

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
  // What has actually happened, for the loading screen. Each line is a real
  // stage rather than a slice of an invented percentage.
  const [steps, setSteps] = useState<LoadingStep[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase === 'extracting' || phase === 'structuring';

  async function structure(text: string, label: string) {
    setPhase('structuring');
    setError(null);
    setSteps((s) => [...s, { label: 'Turning it into fields', done: false }]);
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
    setSteps([{ label: `Reading ${file.name}`, done: false }]);
    try {
      // Vite-specific: `?url` makes the worker a first-party asset in our own
      // bundle. The library takes this as a parameter precisely so that this
      // bundler-specific line lives here, in application code, and not in
      // something we publish.
      const { default: pdfWorkerSrc } = await import(
        'pdfjs-dist/build/pdf.worker.min.mjs?url'
      );
      const extracted = await extractResumeText(file, { pdfWorkerSrc });

      // Real numbers, not a guess. This is also where a two-column layout or a
      // scan would have shown itself, so it is worth saying out loud.
      const words = extracted.text.trim().split(/\s+/).length;
      setSteps([
        {
          label: `Read ${words} words from ${extracted.pages || 1} page${extracted.pages === 1 ? '' : 's'}`,
          done: true,
        },
      ]);

      await structure(extracted.text, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setPhase('error');
      setSteps([]);
      setError(
        err instanceof ExtractionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }

  if (busy && steps.length > 0) {
    return <LoadingScreen steps={steps} title="Reading your resume" />;
  }

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div className="card p-7">
        <h2 className="text-center text-xl font-semibold tracking-tight">Start with your resume</h2>
        <p className="mx-auto mt-1.5 max-w-md text-center text-sm text-stone-600">
          It is read here in this tab. Only the text goes to {provider.info.label}, and only to turn
          it into fields you review.
        </p>

        <div
          className="mt-6 rounded-xl border-2 border-dashed border-stone-300/80 px-6 py-12 text-center transition-colors hover:border-stone-400"
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
          <p className="text-sm text-stone-600">Drop a PDF, DOCX or text file</p>
          <button
            type="button"
            className="btn-primary mt-4"
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
          <p className="mt-4 text-center text-sm text-stone-500">
            Reading a resume takes one model call — add a key in settings, top right.
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

      <p className="mt-4 text-center text-sm text-stone-500">
        No resume to hand?{' '}
        <button
          type="button"
          className="underline underline-offset-2 hover:text-stone-800"
          onClick={() => onBlank({ ...emptyProfile(ids.profile()), label: 'My profile' })}
        >
          Build one from scratch
        </button>
        .
      </p>
    </div>
  );
}
