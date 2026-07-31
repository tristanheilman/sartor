import { useState } from 'react';
import {
  AtsFetchError,
  DEFAULT_CONSTRAINTS,
  detectAts,
  fetchFromAts,
  fromPaste,
  isEmptyJd,
  type JobDescription,
  type TailorConstraints,
} from '../../index';

/** Job description acquisition: paste always works; ATS URLs are a shortcut. */
export function JobPanel({
  jd,
  onJd,
  constraints,
  onConstraints,
  onRun,
  running,
  canRun,
}: {
  jd: JobDescription | null;
  onJd(jd: JobDescription | null): void;
  constraints: TailorConstraints;
  onConstraints(c: TailorConstraints): void;
  onRun(): void;
  running: boolean;
  canRun: boolean;
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState(jd?.text ?? '');
  const [fetching, setFetching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const target = detectAts(url);

  async function pull() {
    if (!target) return;
    setFetching(true);
    setNotice(null);
    try {
      const fetched = await fetchFromAts(target);
      setText(fetched.text);
      onJd(fetched);
      setNotice(`Loaded from ${fetched.source}${fetched.title ? `: ${fetched.title}` : ''}.`);
    } catch (err) {
      setNotice(
        err instanceof AtsFetchError
          ? `${err.message} Open the posting and paste the text below instead.`
          : `Could not load that posting. Paste the text below instead.`,
      );
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="text-base font-semibold">The job posting</h2>

        <label className="label mt-4" htmlFor="jd-text">
          Paste the posting
        </label>
        <textarea
          id="jd-text"
          className="field font-mono text-xs"
          rows={12}
          placeholder="Paste the full job description — requirements, responsibilities, everything."
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onJd(e.target.value.trim() ? fromPaste(e.target.value) : null);
          }}
        />

        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-stone-700">
            Or load it from a Greenhouse, Lever, or Ashby link
          </summary>
          <div className="mt-2 flex gap-2">
            <input
              className="field"
              placeholder="https://boards.greenhouse.io/company/jobs/123456"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" className="btn-secondary" disabled={!target || fetching} onClick={pull}>
              {fetching ? 'Loading…' : 'Load'}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-stone-500">
            {target
              ? `Recognised as ${target.vendor}.`
              : url.trim()
                ? 'Not a Greenhouse, Lever, or Ashby link. Paste the text above instead.'
                : 'These three publish public JSON for their job boards, so the posting can be read directly. LinkedIn, Indeed, and Workday do not — paste those, or use the browser extension when it ships.'}
          </p>
          {notice && <p className="mt-2 text-xs text-amber-800">{notice}</p>}
        </details>
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold">Target</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <span className="label">Length</span>
            <select
              className="field"
              value={constraints.pageTarget}
              onChange={(e) =>
                onConstraints({ ...constraints, pageTarget: Number(e.target.value) as 1 | 2 })
              }
            >
              <option value={1}>One page</option>
              <option value={2}>Two pages</option>
            </select>
          </div>
          <div>
            <span className="label">Tone</span>
            <select
              className="field"
              value={constraints.tone}
              onChange={(e) =>
                onConstraints({ ...constraints, tone: e.target.value as TailorConstraints['tone'] })
              }
            >
              <option value="plain">Plain and direct</option>
              <option value="impact">Outcome first</option>
              <option value="technical">Technically specific</option>
            </select>
          </div>
          <div>
            <span className="label">Seniority (optional)</span>
            <input
              className="field"
              placeholder="Staff"
              value={constraints.seniority}
              onChange={(e) => onConstraints({ ...constraints, seniority: e.target.value })}
            />
          </div>
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Seniority adjusts emphasis only. It never adds scope or ownership your profile does not
          already show.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn-primary"
          disabled={!canRun || running || isEmptyJd(jd)}
          onClick={onRun}
        >
          {running ? 'Tailoring…' : 'Tailor this resume'}
        </button>
        {constraints !== DEFAULT_CONSTRAINTS && null}
        {isEmptyJd(jd) && <span className="text-sm text-stone-500">Paste a posting to continue.</span>}
      </div>
    </div>
  );
}
