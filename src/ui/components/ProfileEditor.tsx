import { useState } from 'react';
import {
  ids,
  splitKeywords,
  type Bullet,
  type Education,
  type Profile,
  type Project,
  type SkillGroup,
  type Work,
} from '../../index';

/**
 * The master profile editor.
 *
 * This is the append-only superset: everything the user has ever done, whether
 * or not it belongs on any particular resume. Nothing here is "the resume" —
 * tailoring selects from this.
 */

interface Props {
  profile: Profile;
  onChange(next: Profile): void;
  /** Shown after an import, before the profile is saved for the first time. */
  warnings?: string[];
}

export function ProfileEditor({ profile, onChange, warnings = [] }: Props) {
  const set = <K extends keyof Profile>(key: K, value: Profile[K]) =>
    onChange({ ...profile, [key]: value });

  const bulletCount =
    profile.work.reduce((n, w) => n + w.bullets.length, 0) +
    profile.projects.reduce((n, p) => n + p.bullets.length, 0);
  const variantCount = [...profile.work, ...profile.projects, ...profile.education]
    .flatMap((e) => e.bullets)
    .reduce((n, b) => n + b.variants.length, 0);

  return (
    <div className="space-y-4">
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">Check these before saving</h3>
          <p className="mt-1 text-xs text-amber-800">
            Extraction is never perfect, and a mistake here quietly affects every resume you tailor
            from this profile.
          </p>
          <ul className="mt-2 space-y-1 pl-4 text-sm text-amber-900">
            {warnings.map((w) => (
              <li key={w} className="list-disc">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-stone-500">
        <span>{profile.work.length} roles</span>
        <span>{bulletCount} bullets</span>
        {/* Only once there are some. A count of zero of a thing nobody has
            heard of explains nothing and takes up the same room. */}
        {variantCount > 0 && (
          <span>
            {variantCount} alternate wording{variantCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <Section title="Basics" defaultOpen>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Full name"
            value={profile.basics.name}
            onChange={(v) => set('basics', { ...profile.basics, name: v })}
          />
          <Field
            label="Headline"
            value={profile.basics.label}
            placeholder="Senior Backend Engineer"
            onChange={(v) => set('basics', { ...profile.basics, label: v })}
          />
          <Field
            label="Email"
            value={profile.basics.email}
            onChange={(v) => set('basics', { ...profile.basics, email: v })}
          />
          <Field
            label="Phone"
            value={profile.basics.phone}
            onChange={(v) => set('basics', { ...profile.basics, phone: v })}
          />
          <Field
            label="City"
            value={profile.basics.location.city ?? ''}
            onChange={(v) =>
              set('basics', { ...profile.basics, location: { ...profile.basics.location, city: v } })
            }
          />
          <Field
            label="Region"
            value={profile.basics.location.region ?? ''}
            onChange={(v) =>
              set('basics', {
                ...profile.basics,
                location: { ...profile.basics.location, region: v },
              })
            }
          />
          <Field
            label="Website"
            value={profile.basics.url}
            className="sm:col-span-2"
            onChange={(v) => set('basics', { ...profile.basics, url: v })}
          />
        </div>
        <TextArea
          label="Summary"
          hint="Your own words. Tailoring rewrites this per posting, but only using facts already in this profile."
          value={profile.basics.summary}
          rows={3}
          onChange={(v) => set('basics', { ...profile.basics, summary: v })}
        />
      </Section>

      <Section title={`Experience (${profile.work.length})`} defaultOpen>
        <EntryList
          entries={profile.work}
          onChange={(next) => set('work', next)}
          create={(): Work => ({
            id: ids.work(),
            name: '',
            position: '',
            location: '',
            startDate: '',
            endDate: '',
            summary: '',
            bullets: [],
            tags: [],
          })}
          addLabel="Add a role"
          fields={(entry, update) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" value={entry.position} onChange={(v) => update({ position: v })} />
              <Field label="Company" value={entry.name} onChange={(v) => update({ name: v })} />
              <Field
                label="Start"
                value={entry.startDate}
                placeholder="2021-03"
                onChange={(v) => update({ startDate: v })}
              />
              <Field
                label="End"
                value={entry.endDate}
                placeholder="Present"
                onChange={(v) => update({ endDate: v })}
              />
              <Field
                label="Location"
                value={entry.location ?? ''}
                className="sm:col-span-2"
                onChange={(v) => update({ location: v })}
              />
            </div>
          )}
          heading={(e) => [e.position, e.name].filter(Boolean).join(' · ') || 'Untitled role'}
        />
      </Section>

      <Section title={`Projects (${profile.projects.length})`}>
        <EntryList
          entries={profile.projects}
          onChange={(next) => set('projects', next)}
          create={(): Project => ({
            id: ids.project(),
            name: '',
            description: '',
            startDate: '',
            endDate: '',
            bullets: [],
            tags: [],
          })}
          addLabel="Add a project"
          fields={(entry, update) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" value={entry.name} onChange={(v) => update({ name: v })} />
              <Field label="Link" value={entry.url ?? ''} onChange={(v) => update({ url: v })} />
              <TextArea
                label="Description"
                value={entry.description}
                rows={2}
                className="sm:col-span-2"
                onChange={(v) => update({ description: v })}
              />
            </div>
          )}
          heading={(e) => e.name || 'Untitled project'}
        />
      </Section>

      <Section title={`Education (${profile.education.length})`}>
        <EntryList
          entries={profile.education}
          onChange={(next) => set('education', next)}
          create={(): Education => ({
            id: ids.education(),
            institution: '',
            area: '',
            studyType: '',
            startDate: '',
            endDate: '',
            courses: [],
            bullets: [],
          })}
          addLabel="Add an institution"
          fields={(entry, update) => (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Institution"
                value={entry.institution}
                onChange={(v) => update({ institution: v })}
              />
              <Field
                label="Qualification"
                value={entry.studyType}
                placeholder="BSc"
                onChange={(v) => update({ studyType: v })}
              />
              <Field label="Field" value={entry.area} onChange={(v) => update({ area: v })} />
              <Field label="End" value={entry.endDate} onChange={(v) => update({ endDate: v })} />
            </div>
          )}
          heading={(e) => e.institution || 'Untitled'}
        />
      </Section>

      <Section title={`Skills (${profile.skills.length} groups)`}>
        <div className="space-y-3">
          {profile.skills.map((group, i) => (
            <div key={group.id} className="rounded-md border border-stone-200 p-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                <Field
                  label="Group"
                  value={group.name}
                  onChange={(v) => updateSkill(i, { name: v })}
                />
                <Field
                  label="Keywords (comma separated)"
                  value={group.keywords.join(', ')}
                  onChange={(v) =>
                    // Not `split(',')`. People write "AWS (Lambda, S3, ECR)",
                    // and a naive split turns one skill into four fragments —
                    // on every keystroke, since this field re-parses what it
                    // just rendered.
                    updateSkill(i, { keywords: splitKeywords(v) })
                  }
                />
                <button
                  type="button"
                  className="btn-ghost self-end text-red-700"
                  onClick={() =>
                    set(
                      'skills',
                      profile.skills.filter((s) => s.id !== group.id),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              set('skills', [...profile.skills, { id: ids.skill(), name: '', keywords: [] }])
            }
          >
            Add a skill group
          </button>
        </div>
      </Section>
    </div>
  );

  function updateSkill(index: number, patch: Partial<SkillGroup>) {
    set(
      'skills',
      profile.skills.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    );
  }
}

/* ------------------------------------------------------------------ */

interface HasBullets {
  id: string;
  bullets: Bullet[];
}

function EntryList<T extends HasBullets>({
  entries,
  onChange,
  create,
  fields,
  heading,
  addLabel,
}: {
  entries: T[];
  onChange(next: T[]): void;
  create(): T;
  fields(entry: T, update: (patch: Partial<T>) => void): React.ReactNode;
  heading(entry: T): string;
  addLabel: string;
}) {
  const update = (id: string, patch: Partial<T>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-4">
      {entries.map((entry) => (
        <div key={entry.id} className="rounded-md border border-stone-200 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{heading(entry)}</h4>
            <button
              type="button"
              className="btn-ghost text-red-700"
              onClick={() => onChange(entries.filter((e) => e.id !== entry.id))}
            >
              Remove
            </button>
          </div>

          {fields(entry, (patch) => update(entry.id, patch))}

          <BulletList
            bullets={entry.bullets}
            onChange={(bullets) => update(entry.id, { bullets } as Partial<T>)}
          />
        </div>
      ))}
      <button type="button" className="btn-secondary" onClick={() => onChange([...entries, create()])}>
        {addLabel}
      </button>
    </div>
  );
}

function BulletList({
  bullets,
  onChange,
}: {
  bullets: Bullet[];
  onChange(next: Bullet[]): void;
}) {
  return (
    <div className="mt-3">
      <span className="label">Bullets</span>
      <div className="space-y-2">
        {bullets.map((b, i) => (
          <div key={b.id}>
            <div className="flex items-start gap-2">
              <span className="pt-2 text-stone-400" aria-hidden>
                •
              </span>
              <textarea
                className="field min-h-[2.4rem] resize-y"
                rows={2}
                aria-label={`Bullet ${i + 1}`}
                value={b.text}
                onChange={(e) =>
                  onChange(bullets.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                }
              />
              <button
                type="button"
                className="btn-ghost mt-0.5 text-red-700"
                aria-label="Remove bullet"
                onClick={() => onChange(bullets.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>

            {b.variants.length > 0 && (
              <details className="mt-1 ml-6 text-xs">
                <summary className="cursor-pointer text-stone-500">
                  {b.variants.length} alternate wording{b.variants.length === 1 ? '' : 's'} of this
                  same fact
                </summary>
                <ul className="mt-1 space-y-1">
                  {b.variants.map((v) => (
                    <li key={v.id} className="flex items-start gap-2 text-stone-600">
                      <span className="flex-1">{v.text}</span>
                      {v.note ? <span className="shrink-0 text-stone-400">{v.note}</span> : null}
                      <button
                        type="button"
                        className="shrink-0 text-red-700 underline"
                        onClick={() =>
                          onChange(
                            bullets.map((x, j) =>
                              j === i ? { ...x, variants: x.variants.filter((y) => y.id !== v.id) } : x,
                            ),
                          )
                        }
                      >
                        remove
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn-ghost mt-1"
        onClick={() => onChange([...bullets, { id: ids.bullet(), text: '', tags: [], variants: [] }])}
      >
        + Add bullet
      </button>
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-stone-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="space-y-3 border-t border-stone-200 p-4">{children}</div>}
    </div>
  );
}

/* Inputs are wrapped in a real `<label>` rather than sitting next to a styled
 * span. Without that they have no accessible name, which breaks screen readers
 * and browser autofill alike — and this is a form the user fills in once and
 * then lives with. */
function Field({
  label,
  value,
  onChange,
  placeholder,
  className = '',
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      <input
        className="field"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  hint,
  className = '',
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  rows?: number;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      <textarea className="field" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <p className="mt-1 text-xs text-stone-500">{hint}</p> : null}
    </label>
  );
}
