import type { Profile, Bullet, SectionKey } from '@/core/schema';
import { SECTION_KEYS } from '@/core/schema';
import { ids } from '@/core/ids';
import type { TailorPlan, PlannedBullet } from './plan';
import type { Violation } from './guard';
import { checkText, profileLexicon } from './guard';
import type { JobDescription } from '@/core/jd/normalize';
import type { TailorConstraints } from './prompt';
import {
  SECTION_HEADINGS,
  type DocEntry,
  type DocSection,
  type ResumeDocument,
} from '@/core/render/model';

/**
 * Turns a tailoring plan into a reviewable set of changes and a rendered
 * document.
 *
 * Two properties matter here and are worth stating explicitly:
 *
 *   1. Every change is independent. Rejecting one reverts that one change to
 *      its master-profile original and nothing else. There is no regeneration,
 *      no second model call, and no risk of the rest of the document shifting
 *      underneath the user while they review.
 *
 *   2. The document is a pure function of (profile, plan, change decisions).
 *      Re-deriving it is cheap, so the UI can re-render on every keystroke of
 *      review without any state getting out of sync.
 */

export type ChangeKind =
  | 'summary'
  | 'bullet-text'
  | 'bullet-drop'
  | 'entry-drop'
  | 'skills'
  | 'section-order';

export type ChangeStatus = 'accepted' | 'rejected';

export interface Change {
  id: string;
  kind: ChangeKind;
  section: SectionKey;
  /** Human-readable location, e.g. "Experience · Acme Robotics". */
  label: string;
  /** ID of the profile element this change acts on. */
  sourceId: string;
  before: string;
  after: string;
  rationale: string;
  status: ChangeStatus;
  /** True once the user has explicitly accepted or rejected it. */
  reviewed: boolean;
  violations: Violation[];
  /** Violation IDs the user has explicitly vouched for. */
  acknowledged: string[];
}

export interface TailorRun {
  id: string;
  profileId: string;
  createdAt: string;
  providerId: string;
  model: string;
  jd: JobDescription;
  constraints: TailorConstraints;
  plan: TailorPlan;
  changes: Change[];
  /** The model's own statement of what the profile could not support. */
  notes: string;
}

/** Deterministic IDs: a change for the same element is always the same change,
 * so review decisions survive a reload. */
function changeId(kind: ChangeKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

function bulletMap(profile: Profile): Map<string, { bullet: Bullet; ownerLabel: string; section: SectionKey }> {
  const map = new Map<string, { bullet: Bullet; ownerLabel: string; section: SectionKey }>();
  for (const w of profile.work) {
    for (const b of w.bullets) map.set(b.id, { bullet: b, ownerLabel: w.name || w.position, section: 'work' });
  }
  for (const p of profile.projects) {
    for (const b of p.bullets) map.set(b.id, { bullet: b, ownerLabel: p.name, section: 'projects' });
  }
  for (const e of profile.education) {
    for (const b of e.bullets) map.set(b.id, { bullet: b, ownerLabel: e.institution, section: 'education' });
  }
  return map;
}

/** The text the plan selects for a bullet, falling back to the canonical text. */
export function plannedText(pb: PlannedBullet, bullet: Bullet): string {
  const text = pb.text.trim();
  if (!text) return bullet.text;
  return text;
}

/**
 * Derives the reviewable change list. Every change is guard-checked at the
 * moment it is created, scoped to its own ID so violations stay attached to the
 * change that produced them.
 */
export function buildChanges(profile: Profile, plan: TailorPlan): Change[] {
  const lexicon = profileLexicon(profile);
  const bullets = bulletMap(profile);
  const changes: Change[] = [];

  const add = (c: Omit<Change, 'violations' | 'acknowledged' | 'status' | 'reviewed'>) => {
    // Only the *new* text is checked. Original profile text is by definition
    // grounded — checking it would produce violations the user cannot act on.
    const violations = c.after.trim() ? checkText(c.after, lexicon, c.id).violations : [];
    changes.push({ ...c, status: 'accepted', reviewed: false, violations, acknowledged: [] });
  };

  // --- Summary -------------------------------------------------------------
  const newSummary = plan.summary.text.trim();
  if (newSummary && newSummary !== profile.basics.summary.trim()) {
    add({
      id: changeId('summary', 'basics'),
      kind: 'summary',
      section: 'summary',
      label: 'Summary',
      sourceId: 'basics',
      before: profile.basics.summary,
      after: newSummary,
      rationale: plan.summary.rationale,
    });
  }

  // --- Entries and bullets -------------------------------------------------
  const entryGroups: Array<{ section: SectionKey; planned: TailorPlan['work']; lookup: Map<string, string> }> = [
    {
      section: 'work',
      planned: plan.work,
      lookup: new Map(profile.work.map((w) => [w.id, `${w.position} · ${w.name}`])),
    },
    {
      section: 'projects',
      planned: plan.projects,
      lookup: new Map(profile.projects.map((p) => [p.id, p.name])),
    },
    {
      section: 'education',
      planned: plan.education,
      lookup: new Map(profile.education.map((e) => [e.id, e.institution])),
    },
  ];

  for (const group of entryGroups) {
    for (const entry of group.planned) {
      const entryLabel = group.lookup.get(entry.id);
      if (entryLabel === undefined) continue; // Unknown id — dropped by validation.

      if (!entry.include) {
        add({
          id: changeId('entry-drop', entry.id),
          kind: 'entry-drop',
          section: group.section,
          label: `${SECTION_HEADINGS[group.section]} · ${entryLabel}`,
          sourceId: entry.id,
          before: entryLabel,
          after: '',
          rationale: 'Dropped from this version.',
        });
        continue;
      }

      for (const pb of entry.bullets) {
        const found = bullets.get(pb.bulletId);
        if (!found) continue;
        const label = `${SECTION_HEADINGS[group.section]} · ${entryLabel}`;

        if (!pb.include) {
          add({
            id: changeId('bullet-drop', pb.bulletId),
            kind: 'bullet-drop',
            section: group.section,
            label,
            sourceId: pb.bulletId,
            before: found.bullet.text,
            after: '',
            rationale: pb.rationale || 'Dropped from this version.',
          });
          continue;
        }

        const text = plannedText(pb, found.bullet);
        if (text.trim() !== found.bullet.text.trim()) {
          add({
            id: changeId('bullet-text', pb.bulletId),
            kind: 'bullet-text',
            section: group.section,
            label,
            sourceId: pb.bulletId,
            before: found.bullet.text,
            after: text,
            rationale: pb.rationale,
          });
        }
      }
    }
  }

  // --- Skills --------------------------------------------------------------
  for (const group of plan.skills) {
    const source = profile.skills.find((s) => s.id === group.id);
    if (!source) continue;
    const before = source.keywords.join(', ');
    const after = group.include ? group.keywords.join(', ') : '';
    if (before !== after) {
      add({
        id: changeId('skills', group.id),
        kind: 'skills',
        section: 'skills',
        label: `Skills · ${source.name}`,
        sourceId: group.id,
        before,
        after,
        rationale: group.include ? 'Reordered and filtered for this posting.' : 'Dropped from this version.',
      });
    }
  }

  // --- Section order -------------------------------------------------------
  const defaultOrder = SECTION_KEYS.join(' → ');
  const planOrder = plan.sectionOrder.join(' → ');
  if (planOrder && planOrder !== defaultOrder) {
    add({
      id: changeId('section-order', 'document'),
      kind: 'section-order',
      section: 'summary',
      label: 'Section order',
      sourceId: 'document',
      before: defaultOrder,
      after: planOrder,
      rationale: 'Reordered to lead with what this posting emphasises.',
    });
  }

  return changes;
}

/** Index of accepted changes by their deterministic ID. */
function acceptedIndex(changes: Change[]): Map<string, Change> {
  return new Map(changes.filter((c) => c.status === 'accepted').map((c) => [c.id, c]));
}

function formatDateRange(start: string, end: string): string {
  const s = start.trim();
  const e = end.trim();
  if (!s && !e) return '';
  return e ? `${s} — ${e}` : `${s} — Present`;
}

/**
 * Resolves profile + plan + review decisions into the final document.
 * Rejected changes simply fall back to the master-profile original.
 */
export function buildDocument(profile: Profile, plan: TailorPlan, changes: Change[]): ResumeDocument {
  const accepted = acceptedIndex(changes);
  const isAccepted = (kind: ChangeKind, sourceId: string) => accepted.has(changeId(kind, sourceId));
  const hasChange = (kind: ChangeKind, sourceId: string) =>
    changes.some((c) => c.id === changeId(kind, sourceId));

  const contact = {
    name: profile.basics.name,
    label: profile.basics.label,
    details: [
      profile.basics.email,
      profile.basics.phone,
      [profile.basics.location.city, profile.basics.location.region].filter(Boolean).join(', '),
      profile.basics.url,
      ...profile.basics.profiles.map((p) => p.url || p.username || '').filter(Boolean),
    ].filter((d): d is string => Boolean(d && d.trim())),
  };

  const summaryText =
    hasChange('summary', 'basics') && isAccepted('summary', 'basics')
      ? plan.summary.text.trim()
      : profile.basics.summary;

  function buildEntries(
    section: 'work' | 'projects' | 'education',
    planned: TailorPlan['work'],
  ): DocEntry[] {
    const sources = profile[section];
    const orderOf = new Map(planned.map((p) => [p.id, p.order]));

    return sources
      // An entry is dropped only when the plan says so *and* the user let it
      // stand. A rejected drop puts the entry straight back.
      .filter((s) => {
        const p = planned.find((x) => x.id === s.id);
        if (!p) return true; // Not mentioned by the plan: keep it.
        if (p.include) return true;
        return !isAccepted('entry-drop', s.id);
      })
      .sort((a, b) => (orderOf.get(a.id) ?? 999) - (orderOf.get(b.id) ?? 999))
      .map((s) => {
        const p = planned.find((x) => x.id === s.id);
        const bulletOrder = new Map((p?.bullets ?? []).map((b) => [b.bulletId, b.order]));

        const docBullets = s.bullets
          .filter((b) => {
            const pb = p?.bullets.find((x) => x.bulletId === b.id);
            if (!pb) return !p; // Plan covered this entry but omitted the bullet: drop it.
            if (pb.include) return true;
            return !isAccepted('bullet-drop', b.id);
          })
          .sort((a, b) => (bulletOrder.get(a.id) ?? 999) - (bulletOrder.get(b.id) ?? 999))
          .map((b) => {
            const pb = p?.bullets.find((x) => x.bulletId === b.id);
            const rephrased = pb ? plannedText(pb, b) : b.text;
            const useRephrasing =
              hasChange('bullet-text', b.id) && isAccepted('bullet-text', b.id);
            return { sourceId: b.id, text: useRephrasing ? rephrased : b.text };
          });

        if (section === 'work') {
          const w = s as Profile['work'][number];
          return {
            sourceId: w.id,
            primary: w.position,
            secondary: w.name,
            meta: formatDateRange(w.startDate, w.endDate),
            aside: w.location ?? '',
            summary: w.summary,
            bullets: docBullets,
          };
        }
        if (section === 'projects') {
          const pr = s as Profile['projects'][number];
          return {
            sourceId: pr.id,
            primary: pr.name,
            secondary: '',
            meta: formatDateRange(pr.startDate, pr.endDate),
            aside: '',
            summary: pr.description,
            bullets: docBullets,
          };
        }
        const ed = s as Profile['education'][number];
        return {
          sourceId: ed.id,
          primary: [ed.studyType, ed.area].filter(Boolean).join(', '),
          secondary: ed.institution,
          meta: formatDateRange(ed.startDate, ed.endDate),
          aside: ed.score ?? '',
          summary: '',
          bullets: docBullets,
        };
      })
      .filter((e) => e.primary || e.secondary || e.bullets.length > 0);
  }

  const skills = profile.skills
    .filter((s) => {
      const p = plan.skills.find((x) => x.id === s.id);
      if (!p || p.include) return true;
      return !isAccepted('skills', s.id);
    })
    .sort((a, b) => {
      const oa = plan.skills.find((x) => x.id === a.id)?.order ?? 999;
      const ob = plan.skills.find((x) => x.id === b.id)?.order ?? 999;
      return oa - ob;
    })
    .map((s) => {
      const p = plan.skills.find((x) => x.id === s.id);
      const useFiltered = hasChange('skills', s.id) && isAccepted('skills', s.id) && p?.include;
      // Even when the model's ordering is accepted, keywords it invented are
      // discarded here rather than rendered. The guard flags them for review;
      // this makes sure an unreviewed one can never reach the document.
      const keywords = useFiltered
        ? p.keywords.filter((k) => s.keywords.some((orig) => orig.toLowerCase() === k.toLowerCase()))
        : s.keywords;
      return { sourceId: s.id, name: s.name, keywords };
    })
    .filter((s) => s.keywords.length > 0);

  const orderAccepted =
    hasChange('section-order', 'document') && isAccepted('section-order', 'document');
  const order: SectionKey[] = orderAccepted ? plan.sectionOrder : [...SECTION_KEYS];

  function buildSection(key: SectionKey): DocSection | null {
    switch (key) {
      case 'summary':
        return summaryText.trim()
          ? { key, heading: SECTION_HEADINGS.summary, kind: 'summary', summary: summaryText }
          : null;
      case 'skills':
        return skills.length ? { key, heading: SECTION_HEADINGS.skills, kind: 'skills', skills } : null;
      case 'work':
      case 'projects':
      case 'education': {
        const entries = buildEntries(key, plan[key]);
        return entries.length ? { key, heading: SECTION_HEADINGS[key], kind: 'entries', entries } : null;
      }
      case 'certificates':
        return profile.certificates.length
          ? {
              key,
              heading: SECTION_HEADINGS.certificates,
              kind: 'list',
              items: profile.certificates.map((c) => ({
                sourceId: c.id,
                text: [c.name, c.issuer, c.date].filter(Boolean).join(' · '),
              })),
            }
          : null;
      case 'awards':
        return profile.awards.length
          ? {
              key,
              heading: SECTION_HEADINGS.awards,
              kind: 'list',
              items: profile.awards.map((a) => ({
                sourceId: a.id,
                text: [a.title, a.awarder, a.date].filter(Boolean).join(' · '),
              })),
            }
          : null;
    }
  }

  // The plan's ordering is honoured, then any section it forgot is appended.
  // Silently losing a section because the model omitted it from an array would
  // be a data-loss bug wearing a formatting costume.
  const fullOrder: SectionKey[] = [];
  for (const key of [...order, ...SECTION_KEYS]) {
    if (!fullOrder.includes(key)) fullOrder.push(key);
  }

  const sections = fullOrder
    .map(buildSection)
    .filter((s): s is DocSection => s !== null);

  return { contact, sections };
}

/**
 * Write-back: accepted rephrasings become variants on the master profile, so
 * the profile accumulates usable phrasings as it is used. The canonical text is
 * never overwritten — variants are additive, and the profile stays lossless.
 */
export function writeBackVariants(profile: Profile, run: TailorRun): Profile {
  const accepted = run.changes.filter(
    (c) => c.kind === 'bullet-text' && c.status === 'accepted' && c.reviewed,
  );
  if (accepted.length === 0) return profile;

  const byBullet = new Map(accepted.map((c) => [c.sourceId, c]));
  const now = new Date().toISOString();
  const note = [run.jd.title, run.jd.company].filter(Boolean).join(' · ') || 'Tailored version';

  const addVariant = (b: Bullet): Bullet => {
    const change = byBullet.get(b.id);
    if (!change) return b;
    const text = change.after.trim();
    if (!text || text === b.text.trim()) return b;
    // Don't store the same phrasing twice.
    if (b.variants.some((v) => v.text.trim() === text)) return b;
    return {
      ...b,
      variants: [...b.variants, { id: ids.variant(), text, source: 'llm', createdAt: now, note }],
    };
  };

  return {
    ...profile,
    work: profile.work.map((w) => ({ ...w, bullets: w.bullets.map(addVariant) })),
    projects: profile.projects.map((p) => ({ ...p, bullets: p.bullets.map(addVariant) })),
    education: profile.education.map((e) => ({ ...e, bullets: e.bullets.map(addVariant) })),
  };
}

/** Changes still carrying a violation the user has not vouched for. */
export function blockingChanges(changes: Change[]): Change[] {
  return changes.filter(
    (c) =>
      c.status === 'accepted' &&
      c.violations.some((v) => !c.acknowledged.includes(v.id)),
  );
}

export function reviewProgress(changes: Change[]): { reviewed: number; total: number } {
  return { reviewed: changes.filter((c) => c.reviewed).length, total: changes.length };
}
