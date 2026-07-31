import { useState } from 'react';
import { useStore, useActiveProvider } from '../store';
import { maskKey } from '../../storage/keys';

/**
 * Key entry.
 *
 * Everything about where the key goes and what it is used for is stated here,
 * at the point of entry, rather than in a privacy policy nobody opens.
 */
export function KeyPanel() {
  const { settings, updateSettings, apiKey, saveKey, forgetKey } = useStore();
  const { provider, all } = useActiveProvider();
  const [draft, setDraft] = useState('');

  const prefixMismatch =
    draft.trim().length > 0 &&
    provider.info.keyPrefix !== undefined &&
    !draft.trim().startsWith(provider.info.keyPrefix);

  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold">Model provider</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="provider">
            Provider
          </label>
          <select
            id="provider"
            className="field"
            value={settings.providerId}
            onChange={(e) => {
              const next = all.find((p) => p.info.id === e.target.value)!;
              void updateSettings({ providerId: next.info.id, model: next.info.defaultModel });
            }}
          >
            {all.map((p) => (
              <option key={p.info.id} value={p.info.id}>
                {p.info.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            className="field"
            value={settings.model}
            onChange={(e) => void updateSettings({ model: e.target.value })}
          >
            {provider.info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {apiKey ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-emerald-50 p-3 text-sm">
          <span className="font-medium text-emerald-900">Key loaded</span>
          <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">{maskKey(apiKey)}</code>
          <button type="button" className="btn-ghost ml-auto" onClick={forgetKey}>
            Forget key
          </button>
        </div>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) {
              saveKey(draft);
              setDraft('');
            }
          }}
        >
          <label className="label" htmlFor="apikey">
            {provider.info.label} API key
          </label>
          <div className="flex gap-2">
            <input
              id="apikey"
              className="field font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.info.keyPrefix ? `${provider.info.keyPrefix}…` : 'Paste your key'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={!draft.trim()}>
              Use key
            </button>
          </div>
          {prefixMismatch ? (
            <p className="mt-1.5 text-xs text-amber-700">
              That does not look like a {provider.info.label} key — they usually start with{' '}
              <code>{provider.info.keyPrefix}</code>. You can still try it.
            </p>
          ) : null}
          <p className="mt-1.5 text-xs text-stone-500">
            Need one?{' '}
            <a
              className="underline"
              href={provider.info.keyUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Create a key at {provider.info.label}
            </a>
            .
          </p>
        </form>
      )}

      <details className="mt-4 text-xs text-stone-600">
        <summary className="cursor-pointer font-medium text-stone-700">
          Exactly where this key goes
        </summary>
        <ul className="mt-2 space-y-1.5 pl-4">
          <li className="list-disc">
            It is held in this tab's <code>sessionStorage</code>. Closing the tab erases it.
          </li>
          <li className="list-disc">
            It is never written to disk, never put in IndexedDB or a cookie, and never included in
            an export.
          </li>
          <li className="list-disc">
            It is sent to exactly one place: <code>{new URL(provider.info.keyUrl).host}</code>'s API,
            directly from your browser. There is no server in between, because this app does not
            have one.
          </li>
          <li className="list-disc">
            <strong>The honest caveat:</strong> {provider.info.browserNote} A key in a browser can be
            read by any script on the page. This app loads no third-party scripts, fonts, or
            analytics — but you should scope the key narrowly and revoke it when you are done.
          </li>
        </ul>
      </details>
    </div>
  );
}
