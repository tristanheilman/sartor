import { useState } from 'react';
import { saveAs } from 'file-saver';
import {
  getTemplate,
  isBuiltInTemplate,
  newId,
  parseSafetyChecks,
  renderTextBlob,
  templateSchema,
  type Change,
  type CoverageReport,
  type ParseCheck,
  type ResumeDocument,
  type Template,
} from '../../index';

/**
 * Coverage signals, the parse-safety checklist, and export.
 *
 * Export is gated on the fabrication guard: while any accepted change still
 * carries a violation the user has not vouched for, the buttons stay disabled.
 * A warning that can be clicked past is a warning that gets clicked past.
 */
type Format = 'pdf' | 'docx' | 'txt';

export function ExportPanel({
  doc,
  coverage,
  blocking,
  templates,
  templateId,
  onTemplate,
  onSaveTemplate,
  onDeleteTemplate,
  onExported,
  pageTarget,
  fileBase,
}: {
  doc: ResumeDocument;
  /** Null when there is no posting: exporting the master profile as it stands. */
  coverage: CoverageReport | null;
  blocking: Change[];
  /** Built-ins followed by the user's own. */
  templates: Template[];
  templateId: string;
  onTemplate(id: string): void;
  onSaveTemplate(template: Template): void;
  onDeleteTemplate(id: string): void;
  /** Called once per download, with the template actually used. */
  onExported(formats: string[], template: Template): void;
  pageTarget: 1 | 2;
  fileBase: string;
}) {
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Template | null>(null);
  // Resolved to the object, not left as an id: a user's template is not in the
  // built-in table, so the renderers could not look it up by name.
  const template = templates.find((t) => t.id === templateId) ?? getTemplate(templateId);

  // The template decides how much fits on a page, so the page-fit check has to
  // see it — otherwise its own advice ("switch to Compact") never changes the
  // answer.
  const checks = parseSafetyChecks(doc, pageTarget, template);

  async function download(kind: Format) {
    setBusy(kind);
    setError(null);
    try {
      const blob =
        kind === 'pdf'
          ? await (await import('../../render/pdf')).renderPdfBlob(doc, template)
          : kind === 'docx'
            ? await (await import('../../render/docx')).renderDocxBlob(doc, template)
            : renderTextBlob(doc);
      saveAs(blob, `${fileBase}.${kind}`);
      // Recorded only once the file exists. A render that throws should leave
      // no trace of a document the user never got.
      onExported([kind], template);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {coverage ? <CoverageCard coverage={coverage} /> : null}

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
            {templates.map((t) => (
              <div
                key={t.id}
                className={`rounded-md border p-3 text-left text-sm transition-colors ${
                  templateId === t.id
                    ? 'border-ink bg-stone-100'
                    : 'border-stone-300 hover:bg-stone-50'
                }`}
              >
                <button type="button" onClick={() => onTemplate(t.id)} className="block w-full text-left">
                  <span className="font-medium">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-stone-500">{t.description}</span>
                </button>
                {!isBuiltInTemplate(t.id) && (
                  <div className="mt-2 flex gap-3 text-xs">
                    <button
                      type="button"
                      className="text-stone-600 underline"
                      onClick={() => setEditing(t)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="text-red-700 underline"
                      onClick={() => onDeleteTemplate(t.id)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="text-sm underline"
              // Start from whatever is selected: adjusting a template you can
              // already see beats filling in eleven numbers from nothing.
              onClick={() =>
                setEditing({
                  ...template,
                  id: newId('tpl'),
                  label: `${template.label} copy`,
                  description: '',
                })
              }
            >
              New template from “{template.label}”
            </button>
          </div>

          <p className="mt-2 text-xs text-stone-500">
            Every template here — including your own — is single-column, real text, standard
            headings, contact details in the body, no tables. A template can change how the document
            looks, never how it parses.
          </p>
        </div>

        {editing && (
          <TemplateEditor
            key={editing.id}
            draft={editing}
            onCancel={() => setEditing(null)}
            onSave={(t) => {
              onSaveTemplate(t);
              onTemplate(t.id);
              setEditing(null);
            }}
          />
        )}

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
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => void download('txt')}
            >
              {busy === 'txt' ? 'Rendering…' : 'Download TXT'}
            </button>
            <span className="self-center text-xs text-stone-500">
              All three come from the same document model, so they always say the same thing. Text
              is the one to paste into an application form.
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

/**
 * The template editor.
 *
 * Only typography is adjustable, and every control is bounded by
 * `templateSchema`. There is deliberately no way to add a column, a table, or a
 * section of your own invention: those are the things that break extraction,
 * and a template that can break extraction would make the parse-safety
 * checklist a lie. Save runs the schema rather than trusting the inputs, so a
 * value typed past a bound is refused with a reason instead of silently
 * clamped.
 */
const FIELD_LABELS: Record<string, string> = {
  label: 'Name',
  description: 'Description',
  bodyFont: 'Typeface',
  headingFont: 'Typeface',
  docxFont: 'Word font',
  baseSize: 'Body size',
  lineHeight: 'Line height',
  pageMargin: 'Page margin',
  sectionGap: 'Gap between sections',
  entryGap: 'Gap between entries',
  bulletGap: 'Gap between bullets',
};

function TemplateEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: Template;
  onSave(t: Template): void;
  onCancel(): void;
}) {
  const [t, setT] = useState<Template>(draft);
  const [problems, setProblems] = useState<string[]>([]);

  const set = <K extends keyof Template>(key: K, value: Template[K]) =>
    setT((prev) => ({ ...prev, [key]: value }));

  const num = (key: keyof Template, label: string, step: number, hint: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input
        type="number"
        step={step}
        className="field"
        value={String(t[key])}
        onChange={(e) => set(key, Number(e.target.value) as Template[keyof Template])}
      />
      <span className="mt-0.5 block text-xs text-stone-500">{hint}</span>
    </label>
  );

  function save() {
    const parsed = templateSchema.safeParse(t);
    if (!parsed.success) {
      // Report the problem against the label on screen, not the field name in
      // the schema. "baseSize" is our word for it, not the reader's.
      setProblems(
        parsed.error.issues.map((i) => {
          const key = String(i.path[0] ?? '');
          return `${FIELD_LABELS[key] ?? (key || 'Template')}: ${i.message}`;
        }),
      );
      return;
    }
    onSave(parsed.data);
  }

  return (
    <div className="mt-4 rounded-md border border-stone-300 bg-stone-50 p-4">
      <h3 className="text-sm font-semibold">Edit template</h3>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Name</span>
          <input className="field" value={t.label} onChange={(e) => set('label', e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Description</span>
          <input
            className="field"
            value={t.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </label>

        <label className="block">
          <span className="label">Typeface</span>
          <select
            className="field"
            value={t.bodyFont}
            // Body and heading fonts move together. A serif body under a sans
            // heading is a choice; a serif body under a *bold serif* heading is
            // the only pairing that stays consistent across both renderers.
            onChange={(e) => {
              const serif = e.target.value === 'Times-Roman';
              setT((prev) => ({
                ...prev,
                bodyFont: serif ? 'Times-Roman' : 'Helvetica',
                headingFont: serif ? 'Times-Bold' : 'Helvetica-Bold',
              }));
            }}
          >
            <option value="Helvetica">Sans (Helvetica)</option>
            <option value="Times-Roman">Serif (Times)</option>
          </select>
        </label>
        <label className="block">
          <span className="label">Word font</span>
          <select
            className="field"
            value={t.docxFont}
            onChange={(e) => set('docxFont', e.target.value as Template['docxFont'])}
          >
            {['Calibri', 'Cambria', 'Arial', 'Georgia', 'Times New Roman'].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-xs text-stone-500">
            Used for the DOCX only. Limited to fonts that ship with Word everywhere.
          </span>
        </label>

        {num('baseSize', 'Body size (pt)', 0.5, '8.5 to 13. Below 9 gets hard to read in print.')}
        {num('lineHeight', 'Line height', 0.02, '1.05 to 1.8.')}
        {num('pageMargin', 'Page margin (pt)', 2, '24 to 90. Under 24 risks printer clipping.')}
        {num('sectionGap', 'Gap between sections (pt)', 1, '0 to 40.')}
        {num('entryGap', 'Gap between entries (pt)', 1, '0 to 40.')}
        {num('bulletGap', 'Gap between bullets (pt)', 1, '0 to 20.')}
      </div>

      <div className="mt-3 flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={t.uppercaseHeadings}
            onChange={(e) => set('uppercaseHeadings', e.target.checked)}
          />
          Uppercase headings
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={t.headingRule}
            onChange={(e) => set('headingRule', e.target.checked)}
          />
          Rule under headings
        </label>
      </div>

      {problems.length > 0 && (
        <ul className="mt-3 list-disc rounded-md border border-red-300 bg-red-50 p-3 pl-8 text-sm text-red-900">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-primary" onClick={save}>
          Save template
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
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
