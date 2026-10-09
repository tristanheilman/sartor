import { profileSchema, type Profile } from '../core/schema';
import { fromPaste, type JobDescription } from '../core/jd/normalize';
import { getTemplate, isBuiltInTemplate, TEMPLATES, type Template } from '../core/render/templates';
import { buildDocument, blockingChanges, type Change } from '../core/tailor/apply';
import { unsupportedSummaryTerms } from '../core/tailor/support';
import { estimateHeight, pageHeight } from '../core/render/model';
import { PROVIDERS, type ProviderConfig } from '../core/provider';
import { CliError, EXIT, describeIssues, readJson, readText, type Io } from './io';
import type { RunFile } from './runfile';

export async function loadProfile(io: Io, path: string | undefined): Promise<Profile> {
  if (!path) {
    throw new CliError('missing_profile', 'No profile given.', 'Pass --profile <profile.json>. `sartor ingest apply` writes one from a structured resume.', EXIT.usage);
  }
  const json = await readJson(io, path, 'the profile');
  const parsed = profileSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      'invalid_profile',
      `The profile at ${path} does not match the profile schema: ${describeIssues(parsed.error.issues)}.`,
      'Run `sartor schema profile` for the schema, or re-create the profile with `sartor ingest apply`.',
    );
  }
  return parsed.data;
}

export async function loadPosting(io: Io, path: string | undefined): Promise<JobDescription> {
  if (!path) {
    throw new CliError('missing_posting', 'No job posting given.', 'Pass --posting <posting.txt>, or --posting - to read it from stdin.', EXIT.usage);
  }
  const text = await readText(io, path, 'the job posting');
  if (!text.trim()) {
    throw new CliError('empty_posting', `The job posting at ${path} is empty.`, 'Paste the full posting text into the file: title, responsibilities and requirements.');
  }
  return fromPaste(text);
}

export function parsePages(value: string | undefined): 1 | 2 {
  if (value === undefined || value === '1') return 1;
  if (value === '2') return 2;
  throw new CliError('invalid_pages', `--pages must be 1 or 2, not ${JSON.stringify(value)}.`, 'A resume is one page or two; pass --pages 1 or --pages 2.', EXIT.usage);
}

export function parseTemplate(value: string | undefined): Template {
  const id = value ?? 'classic';
  if (!isBuiltInTemplate(id)) {
    throw new CliError(
      'unknown_template',
      `There is no template called ${JSON.stringify(id)}.`,
      `Use one of: ${TEMPLATES.map((t) => t.id).join(', ')}. \`sartor templates\` describes each.`,
      EXIT.usage,
    );
  }
  return getTemplate(id);
}

export function parseTone(value: string | undefined): 'plain' | 'impact' | 'technical' {
  const tone = value ?? 'plain';
  if (tone === 'plain' || tone === 'impact' || tone === 'technical') return tone;
  throw new CliError('invalid_tone', `--tone must be plain, impact or technical, not ${JSON.stringify(tone)}.`, 'Leave it out for plain.', EXIT.usage);
}

/** Names rather than ids: what a reader — or an agent — can act on. */
function entryName(profile: Profile, section: 'work' | 'projects' | 'education', id: string): string {
  if (section === 'work') {
    const w = profile.work.find((x) => x.id === id);
    return w ? `${w.position}${w.name ? `, ${w.name}` : ''}` : id;
  }
  if (section === 'projects') return profile.projects.find((x) => x.id === id)?.name ?? id;
  const e = profile.education.find((x) => x.id === id);
  return e ? [e.studyType, e.area, e.institution].filter(Boolean).join(', ') : id;
}

/** What the run would print, measured the way the fit pass measures it. */
export function summarizeRun(file: RunFile) {
  const { profile, run } = file;
  const template = getTemplate(file.template);
  const doc = buildDocument(profile, run.plan, run.changes);
  const height = estimateHeight(doc, template);
  const page = pageHeight(template);
  const pagesNeeded = Math.max(1, Math.ceil(height / page - 1e-9));

  const entries = (['work', 'projects', 'education'] as const).flatMap((section) =>
    doc.sections
      .filter((s) => s.key === section)
      .flatMap((s) => s.entries ?? [])
      .map((e) => ({ section, name: entryName(profile, section, e.sourceId), bullets: e.bullets.length })),
  );

  const blocking = blockingChanges(run.changes);
  return {
    pageTarget: run.constraints.pageTarget,
    template: file.template,
    estimate: {
      pages: pagesNeeded,
      // Of the last page, as the fit pass sees it. The printed last line sits
      // a little above this: the estimate rounds wrapping up, never down.
      lastPageFill: Math.round(((height - (pagesNeeded - 1) * page) / page) * 1000) / 1000,
      fits: pagesNeeded <= run.constraints.pageTarget,
    },
    entries,
    skills: doc.sections.find((s) => s.key === 'skills')?.skills?.map((g) => g.name) ?? [],
    changes: {
      total: run.changes.length,
      accepted: run.changes.filter((c) => c.status === 'accepted').length,
      rejected: run.changes.filter((c) => c.status === 'rejected').length,
      unreviewed: run.changes.filter((c) => !c.reviewed).length,
      blocking: blocking.length,
    },
    notes: run.notes,
    // Numbered as `review` lists the changes, so an agent can name the one to
    // reject.
    summaryUnsupported: unsupportedSummaryTerms(profile, run.plan, run.changes).map((t) => ({
      term: t.term,
      restoredBy: t.restoredBy.map((id) => run.changes.findIndex((c) => c.id === id) + 1),
    })),
  };
}

/** Changes are addressed by their number in the review list, or by id. */
export function resolveChanges(changes: Change[], refs: string[]): Change[] {
  return refs.flatMap((ref) =>
    ref
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const n = Number(r);
        const found = Number.isInteger(n) && n >= 1 && n <= changes.length ? changes[n - 1] : changes.find((c) => c.id === r);
        if (!found) {
          throw new CliError(
            'unknown_change',
            `There is no change ${JSON.stringify(r)} in this run.`,
            `Refer to a change by its number (1-${changes.length}) or its id, as \`sartor review <run>\` lists them.`,
            EXIT.usage,
          );
        }
        return found;
      }),
  );
}

/** The environment variable a provider's key is read from. Never a flag: flags end up in shell history. */
export const KEY_ENV: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

export function providerConfig(io: Io, providerId: string | undefined, model: string | undefined): { id: string; cfg: ProviderConfig } {
  const id = providerId ?? 'anthropic';
  const provider = PROVIDERS[id as keyof typeof PROVIDERS];
  if (!provider) {
    throw new CliError('unknown_provider', `There is no provider called ${JSON.stringify(id)}.`, `Use one of: ${Object.keys(PROVIDERS).join(', ')}.`, EXIT.usage);
  }
  const names = KEY_ENV[id] ?? [];
  const apiKey = names.map((n) => io.env[n]).find((v) => v && v.trim());
  if (!apiKey) {
    throw new CliError(
      'missing_api_key',
      `No API key for ${provider.info.label}.`,
      `Set ${names.join(' or ')} in the environment — or use the agent workflow instead (\`sartor tailor prompt\` / \`sartor tailor apply\`), which needs no key.`,
      EXIT.provider,
    );
  }
  const chosen = model ?? provider.info.defaultModel;
  return { id, cfg: { apiKey: apiKey.trim(), model: chosen } };
}
