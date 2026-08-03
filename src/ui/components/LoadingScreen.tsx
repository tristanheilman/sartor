import { useEffect, useState } from 'react';

/**
 * The screen while a resume is being read.
 *
 * Every line here is something that actually happened. A resume takes long
 * enough to read that silence feels broken, and the temptation is to fill it
 * with a progress bar — but nothing downstream knows how long a model call will
 * take, so any percentage would be invented. Naming the real stage is both
 * honest and more reassuring, because it tells you *where* it is rather than
 * how far.
 *
 * The elapsed counter appears only once a wait has gone on long enough to feel
 * wrong. Before that it is noise.
 */

export interface LoadingStep {
  /** Present tense while running, past tense once done — set by the caller. */
  label: string;
  done: boolean;
}

export function LoadingScreen({ steps, title }: { steps: LoadingStep[]; title: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const current = steps.find((s) => !s.done);

  return (
    <div
      // Opaque, because a loader you can read the page through is not a loader.
      // The haze still shows: the fill is the paper colour, not white.
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-paper/80 px-6 backdrop-blur-xl"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-5">
        <div className="spinner" />

        <div className="flex min-h-[1.5rem] items-center">
          <p key={current?.label} className="rise text-sm font-medium text-stone-700">
            {current?.label ?? title}
          </p>
        </div>

        {/* What is already done, so the wait has visible ground behind it. */}
        <div className="flex flex-col items-center gap-1">
          {steps
            .filter((s) => s.done)
            .map((s) => (
              <p key={s.label} className="text-xs text-stone-500">
                {s.label}
              </p>
            ))}
        </div>

        {elapsed >= 8 && (
          <p className="rise font-mono text-xs text-stone-400">
            {elapsed}s · larger resumes take longer
          </p>
        )}
      </div>
    </div>
  );
}
