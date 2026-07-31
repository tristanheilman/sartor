import { useState } from 'react';
import { saveAs } from 'file-saver';
import {
  TEMPLATES,
  parseSafetyChecks,
  type Change,
  type CoverageReport,
  type ParseCheck,
  type ResumeDocument,
} from '../../index';

/**
 * Coverage signals, the parse-safety checklist, and export.
 *
 * Export is gated on the fabrication guard: while any accepted change still
 * carries a violation the user has not vouched for, the buttons stay disabled.
 * A warning that can be clicked past is a warning that gets clicked past.
 */
export function ExportPanel({
  doc,
  coverage,
  blocking,
  templateId,
  onTemplate,
  pageTarget,
  fileBase,
}: {
  doc: ResumeDocument;
  coverage: CoverageReport;
  blocking: Change[];
  templateId: string;
  onTemplate(id: string): void;
  pageTarget: 1 | 2;
  fileBase: string;
}) {
  const [busy, setBusy] = useState<'pdf' | 'docx' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const checks = parseSafetyChecks(doc, pageTarget);

  async function download(kind: 'pdf' | 'docx') {
    setBusy(kind);
    setError(null);
    try {
      const blob =
        kind === 'pdf'
          ? await (await import('../../render/pdf')).renderPdfBlob(doc, templateId)
          : await (await import('../../render/docx')).renderDocxBlob(doc, templateId);
      saveAs(blob, `${fileBase}.${kind}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <CoverageCard coverage={coverage} />

      <div className="card p-5">
        <h2 className="text-base font-semibold">Parse safety</h2>
        <p className="mt-1 text-sm text-stone-600">
          Checkable properties of the document below. These are the things that actually break text
          extraction — not a guess at how some system will grade you.
        </p>
        <ul className="mt-3 space-y-2">
          {checks.map((c) => (
            <CheckRow key={c.id} check={c} />
          ))}
        </ul>
      </div>

      <div className="card p-5">
        <h2 className="text-base font-semibold">Export</h2>

        <div className="mt-3">
          <span className="label">Template</span>
          <div className="grid gap-2 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTemplate(t.id)}
                className={`rounded-md border p-3 text-left text-sm transition-colors ${
                  templateId === t.id
                    ? 'border-ink bg-stone-100'
                    : 'border-stone-300 hover:bg-stone-50'
                }`}
              >
                <span className="font-medium">{t.label}</span>
                <span className="mt-0.5 block text-xs text-stone-500">{t.description}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            All three are single-column, real text, standard headings, contact details in the body,
            no tables. Choosing one can change how it looks, never how it parses.
          </p>
        </div>

        {blocking.length > 0 ? (
          <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            <strong className="font-semibold">Export blocked.</strong> {blocking.length} accepted
            change{blocking.length === 1 ? '' : 's'} still contain{blocking.length === 1 ? 's' : ''}{' '}
            content that is not in your master profile. Go back to Review and either reject{' '}
            {blocking.length === 1 ? 'it' : 'them'} or confirm the facts are yours.
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => void download('pdf')}
            >
              {busy === 'pdf' ? 'Rendering…' : 'Download PDF'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => void download('docx')}
            >
              {busy === 'docx' ? 'Rendering…' : 'Download DOCX'}
            </button>
            <span className="self-center text-xs text-stone-500">
              Both come from the same document model, so they always say the same thing.
            </span>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </div>
        )}
      </div>

      <DocumentPreview doc={doc} />
    </div>
  );
}

function CheckRow({ check }: { check: ParseCheck }) {
  const mark = { pass: '✓', warn: '!', fail: '✕' }[check.status];
  const tone = {
    pass: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-900',
    fail: 'bg-red-100 text-red-900',
  }[check.status];

  return (
    <li className="flex items-start gap-3 text-sm">
      <span className={`mt-0.5 h-5 w-5 shrink-0 rounded text-center font-bold ${tone}`}>{mark}</span>
      <div>
        <span className="font-medium">{check.label}</span>
        {check.structural && (
          <span className="ml-2 rounded bg-stone-200 px-1.5 py-0.5 text-xs text-stone-600">
            guaranteed by the template
          </span>
        )}
        <p className="text-stone-600">{check.detail}</p>
      </div>
    </li>
  );
}

function CoverageCard({ coverage }: { coverage: CoverageReport }) {
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">What the posting asked for</h2>
      <p className="mt-1 text-sm text-stone-600">
        There is no score here on purpose. The widely-quoted claim that most resumes are
        auto-rejected by software is not supported by evidence, and a made-up number would only push
        you toward keyword stuffing. These three lists are things you can actually check.
      </p>

      <div className="mt-4 space-y-4">
        <TermGroup
          title={`In your resume (${coverage.present.length})`}
          tone="bg-emerald-50 border-emerald-200"
          empty="None of the terms we detected appear in this version."
          terms={coverage.present}
          renderExtra={(t) => (t.locations.length ? ` — ${t.locations.join('; ')}` : '')}
        />
        <TermGroup
          title={`In your profile, but not in this version (${coverage.inProfileOnly.length})`}
          tone="bg-amber-50 border-amber-200"
          empty="Nothing relevant was left behind."
          terms={coverage.inProfileOnly}
          renderExtra={() => ' — reject a drop in Review to pull it back in'}
        />
        <TermGroup
          title={`Not anywhere in your profile (${coverage.missing.length})`}
          tone="bg-stone-100 border-stone-300"
          empty="Nothing in the posting is missing from your profile."
          terms={coverage.missing}
          renderExtra={() => ''}
          footer="These are real gaps, not formatting problems. This tool will not add them for you — if you do have the experience, add it to your master profile first."
        />
      </div>
    </div>
  );
}

function TermGroup({
  title,
  tone,
  terms,
  empty,
  renderExtra,
  footer,
}: {
  title: string;
  tone: string;
  terms: CoverageReport['terms'];
  empty: string;
  renderExtra(t: CoverageReport['terms'][number]): string;
  footer?: string;
}) {
  return (
    <div className={`rounded-md border p-3 ${tone}`}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {terms.length === 0 ? (
        <p className="mt-1 text-sm text-stone-600">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {terms.map((t) => (
            <li key={t.norm}>
              <span className="font-medium">{t.term}</span>
              {t.emphasised && (
                <span className="ml-1.5 rounded bg-white/70 px-1 text-xs text-stone-600">
                  stated as a requirement
                </span>
              )}
              <span className="text-stone-600">{renderExtra(t)}</span>
            </li>
          ))}
        </ul>
      )}
      {footer && <p className="mt-2 text-xs text-stone-600">{footer}</p>}
    </div>
  );
}

/** A plain-HTML mirror of the render model, so review does not require a download. */
function DocumentPreview({ doc }: { doc: ResumeDocument }) {
  return (
    <div className="card p-5">
      <h2 className="text-base font-semibold">Preview</h2>
      <div className="mt-3 rounded-md border border-stone-200 bg-white p-6 text-[13px] leading-relaxed">
        <p className="text-xl font-bold">{doc.contact.name}</p>
        {doc.contact.label && <p className="text-stone-700">{doc.contact.label}</p>}
        {doc.contact.details.length > 0 && (
          <p className="mt-1 text-stone-600">{doc.contact.details.join('  ·  ')}</p>
        )}

        {doc.sections.map((s) => (
          <section key={s.key} className="mt-5">
            <h3 className="border-b border-stone-400 pb-1 text-xs font-bold tracking-wider uppercase">
              {s.heading}
            </h3>
            {s.kind === 'summary' && <p className="mt-2">{s.summary}</p>}
            {s.kind === 'skills' &&
              s.skills?.map((g) => (
                <p key={g.sourceId} className="mt-1.5">
                  <span className="font-semibold">{g.name}:</span> {g.keywords.join(', ')}
                </p>
              ))}
            {s.kind === 'list' &&
              s.items?.map((i) => (
                <p key={i.sourceId} className="mt-1">
                  {i.text}
                </p>
              ))}
            {s.kind === 'entries' &&
              s.entries?.map((e) => (
                <div key={e.sourceId} className="mt-3">
                  <div className="flex justify-between gap-4">
                    <span className="font-semibold">{e.primary}</span>
                    <span className="shrink-0 text-stone-600">{e.meta}</span>
                  </div>
                  {(e.secondary || e.aside) && (
                    <div className="flex justify-between gap-4">
                      <span>{e.secondary}</span>
                      <span className="shrink-0 text-stone-600">{e.aside}</span>
                    </div>
                  )}
                  {e.summary && <p className="mt-1">{e.summary}</p>}
                  <ul className="mt-1">
                    {e.bullets.map((b) => (
                      <li key={b.sourceId} className="flex gap-2">
                        <span className="text-stone-500">•</span>
                        <span>{b.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}
