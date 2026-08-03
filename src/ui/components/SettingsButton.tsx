import { useEffect, useRef, useState } from 'react';
import { KeyPanel } from './KeyPanel';
import { useActiveProvider } from '../store';

/**
 * Provider and key, behind a button.
 *
 * These are settings, not a step: they are touched once and then never again
 * for the rest of a session, and giving them a permanent panel at the top of
 * every screen made the first thing anyone saw a form about API keys rather
 * than their own resume.
 *
 * The dot on the button carries the only part that matters at a glance —
 * whether a key is loaded — so hiding the panel does not hide its state.
 */
export function SettingsButton() {
  const { ready } = useActiveProvider();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={ready ? 'Settings — key loaded' : 'Settings — no key yet'}
        className="relative flex h-9 w-9 items-center justify-center rounded-full border border-stone-300/70 bg-white/70 text-stone-600 transition-colors hover:bg-white hover:text-stone-900"
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span
          className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white ${
            ready ? 'bg-emerald-500' : 'bg-amber-400'
          }`}
        />
      </button>

      {open && (
        <div className="rise absolute top-11 right-0 z-40 w-[22rem] max-w-[calc(100vw-2rem)]">
          <div className="card p-4">
            <KeyPanel />
            <p className="mt-3 border-t border-stone-200/70 pt-3 text-xs leading-snug text-stone-500">
              Everything stays in this browser — profiles in IndexedDB, your key in this tab's
              sessionStorage. Nothing is uploaded except the model calls you trigger.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
