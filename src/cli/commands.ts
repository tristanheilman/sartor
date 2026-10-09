import { basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { profileSchema } from '../core/schema';
import { ids } from '../core/ids';
import { TEMPLATES, getTemplate } from '../core/render/templates';
import { TAILOR_PLAN_JSON_SCHEMA, tailorPlanSchema } from '../core/tailor/plan';
import { TAILOR_SYSTEM_PROMPT, buildTailorUserPrompt, type TailorConstraints } from '../core/tailor/prompt';
import { buildChanges, buildDocument, blockingChanges, type Change, type TailorRun } from '../core/tailor/apply';
import { validatePlan, runTailor } from '../core/tailor/run';
import { fitToTarget } from '../core/tailor/fit';
import { INGEST_JSON_SCHEMA, INGEST_SYSTEM_PROMPT, ingestResume, structuredToProfile } from '../core/parse/ingest';
import type { DuplicateBullets } from '../core/parse/duplicates';
import { buildCoverage } from '../core/tailor/coverage';
import { documentToSlices } from '../core/render/model';
import { parseSafetyChecks } from '../core/render/parseSafety';
import { renderPlainText } from '../core/render/text';
import { getProvider, ProviderError } from '../core/provider';
import { CliError, EXIT, describeIssues, readBytes, readJson, readText, writeOut, type Io, type Result } from './io';
import { RUN_FORMAT, readRunFile, writeRunFile, type RunFile } from './runfile';
import {
  loadPosting,
  loadProfile,
  parsePages,
  parseTemplate,
  parseTone,
  providerConfig,
  resolveChanges,
  summarizeRun,
} from './shared';

export interface Ctx {
  io: Io;
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

/** Quoted so a suggested command can be pasted as-is, spaces and all. */
const q = (s: string) => (/^[\w./@:-]+$/.test(s) ? s : JSON.stringify(s));

function requirePositional(ctx: Ctx, index: number, what: string, usage: string): string {
  const v = ctx.positionals[index];
  if (!v) throw new CliError('missing_argument', `Missing ${what}.`, `Usage: ${usage}`, EXIT.usage);
  return v;
}

/* ------------------------------------------------------------------ *
 * Reference
 * ------------------------------------------------------------------ */

export async function templatesCommand(): Promise<Result> {
  const data = TEMPLATES.map((t) => ({
    id: t.id,
    label: t.label,
    description: t.description,
    font: t.bodyFont,
    size: t.baseSize,
  }));
  return {
    data,
    text: data.map((t) => `${t.id.padEnd(14)} ${t.label.padEnd(14)} ${t.description}`).join('\n'),
  };
}

export async function schemaCommand(ctx: Ctx): Promise<Result> {
  const which = requirePositional(ctx, 0, 'which schema', 'sartor schema <profile|plan|structured-resume>');
  const schemas: Record<string, unknown> = {
    profile: z.toJSONSchema(profileSchema, { io: 'input' }),
    plan: TAILOR_PLAN_JSON_SCHEMA,
    'structured-resume': INGEST_JSON_SCHEMA,
  };
  const schema = schemas[which];
  if (!schema) {
    throw new CliError('unknown_schema', `There is no schema called ${JSON.stringify(which)}.`, `Use one of: ${Object.keys(schemas).join(', ')}.`, EXIT.usage);
  }
  return { data: schema, text: JSON.stringify(schema, null, 2) };
}

/* ------------------------------------------------------------------ *
 * Reading a resume
 * ------------------------------------------------------------------ */

/** Turns a PDF, DOCX or text file into text, the way the app does in the browser. */
async function extract(io: Io, path: string): Promise<{ text: string; pages: number; kind: string }> {
  const ext = extname(path).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return { text: await readText(io, path, 'the resume'), pages: 0, kind: 'text' };
  }
  const bytes = await readBytes(io, path, 'the resume');
  const file = new File([bytes], basename(path));

  let parse: typeof import('../core/parse/extract');
  let pdfWorkerSrc: string | undefined;
  try {
    parse = await import('../core/parse/extract');
    if (ext === '.pdf') {
      pdfWorkerSrc = pathToFileURL(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    }
  } catch {
    throw new CliError(
      'missing_dependency',
      `Reading ${ext.slice(1).toUpperCase()} files needs ${ext === '.pdf' ? 'pdfjs-dist' : 'mammoth'}, which is not installed.`,
      `Install it next to sartor: npm install ${ext === '.pdf' ? 'pdfjs-dist' : 'mammoth'}`,
      EXIT.input,
    );
  }
  try {
    const out = await parse.extractResumeText(file, { pdfWorkerSrc });
    return { text: out.text, pages: out.pages, kind: out.kind };
  } catch (e) {
    throw new CliError('extract_failed', `Could not read text out of ${path}: ${e instanceof Error ? e.message : String(e)}`, 'If it is a scan, it has no text to read; export the resume again from the program that made it, or paste the text into a .txt file.');
  }
}

export async function extractCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the resume file', 'sartor extract <resume.pdf|docx|txt> [--out text.txt]');
  const out = await extract(ctx.io, path);
  const words = out.text.trim().split(/\s+/).filter(Boolean).length;
  const target = str(ctx.flags.out);
  if (target) await writeOut(ctx.io, target, out.text);
  return {
    data: { ...(target ? { written: target } : { text: out.text }), pages: out.pages, kind: out.kind, words },
    text: target ? `Wrote ${words} words to ${target}.` : out.text,
    next: [`sartor ingest prompt ${q(path)}`],
  };
}

/**
 * A prompt for the calling agent, printed or — with `--out` — written to a
 * file.
 *
 * The file is the payload itself, not an envelope around it. It exists so an
 * agent can save a long prompt without a shell redirect: to a tool permission,
 * `sartor ... > file` is more than a sartor command, so a skill's
 * `Bash(sartor *)` grant did not cover it and Claude Code stopped to ask.
 */
async function promptResult(
  ctx: Ctx,
  payload: { task: string; instructions: string; input: string; schema: unknown },
  text: string,
  next: string[],
): Promise<Result> {
  // `next` travels with the prompt. The task says to run it, and an agent
  // reading only the file — the point of --out — had no `next` to run: it
  // lived in the stdout envelope alone.
  const full = { ...payload, next };
  const out = str(ctx.flags.out);
  if (!out) return { data: full, text, next };
  await writeOut(ctx.io, out, `${JSON.stringify(full, null, 2)}\n`);
  return {
    data: { written: out, contains: Object.keys(full) },
    text: `Wrote the prompt to ${out}. Read it, write the JSON it asks for, then run the command in its \`next\`.`,
    next,
  };
}

export async function ingestPromptCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the resume file', 'sartor ingest prompt <resume.pdf|docx|txt>');
  const { text } = await extract(ctx.io, path);
  if (!text.trim()) {
    throw new CliError('empty_resume', `No text came out of ${path}.`, 'If it is a scan, export it again from the program that made it, or paste the text into a .txt file.');
  }
  const input = `Convert this resume into the JSON structure.\n\n---\n${text}\n---`;
  return promptResult(
    ctx,
    {
      task: 'Structure the resume below into JSON that matches `schema` exactly, following `instructions`. Write only the JSON to a file, then run the first command in `next`, with your file in place of structured.json.',
      instructions: INGEST_SYSTEM_PROMPT,
      input,
      schema: INGEST_JSON_SCHEMA,
    },
    `# Instructions\n\n${INGEST_SYSTEM_PROMPT}\n\n# Input\n\n${input}\n\n# Output\n\nJSON matching \`sartor schema structured-resume\`.`,
    ['sartor ingest apply structured.json --out profile.json'],
  );
}

function profileStats(profile: z.infer<typeof profileSchema>) {
  return {
    name: profile.basics.name,
    roles: profile.work.length,
    projects: profile.projects.length,
    education: profile.education.length,
    bullets: [...profile.work, ...profile.projects, ...profile.education].reduce((n, e) => n + e.bullets.length, 0),
    skillGroups: profile.skills.length,
  };
}

/**
 * Bullets the structuring flagged as one fact said twice, with both wordings,
 * so the person can choose which to keep. Left alone, tailoring can pick
 * both — or the weaker one.
 */
function repeatsIn(profile: z.infer<typeof profileSchema>, pairs: DuplicateBullets[]) {
  const text = new Map(
    [...profile.work, ...profile.projects, ...profile.education].flatMap((e) => e.bullets.map((b) => [b.id, b.text] as const)),
  );
  return pairs.map((p) => ({ entry: p.entryName, bulletIds: p.bulletIds, texts: p.bulletIds.map((id) => text.get(id) ?? '') }));
}

function repeatWarning(repeats: ReturnType<typeof repeatsIn>): string[] {
  return repeats.length
    ? [`${repeats.length} pair(s) of bullets look like the same fact said twice (data.repeats). Show the person both wordings and ask which to keep; both stay in the profile until they decide.`]
    : [];
}

export async function ingestApplyCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the structured resume', 'sartor ingest apply <structured.json|-> --out profile.json');
  const out = str(ctx.flags.out) ?? 'profile.json';
  const json = await readJson(ctx.io, path, 'the structured resume');
  const result = structuredToProfile(json, str(ctx.flags.label) ?? 'Imported resume');
  if (!result.ok) {
    throw new CliError(
      'invalid_structured_resume',
      `The structured resume does not match the schema: ${describeIssues(result.issues)}.`,
      'Fix those fields and run this again. `sartor schema structured-resume` prints the schema; every field is required, using "" or [] when the resume has nothing for it.',
      EXIT.input,
      { issues: result.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
    );
  }
  await writeOut(ctx.io, out, `${JSON.stringify(result.profile, null, 2)}\n`);
  const stats = profileStats(result.profile);
  const repeats = repeatsIn(result.profile, result.duplicates);
  return {
    data: { written: out, profile: stats, repeats },
    text: `Wrote ${out}: ${stats.name || '(no name)'} — ${stats.roles} roles, ${stats.projects} projects, ${stats.bullets} bullets.`,
    warnings: [
      ...result.warnings,
      ...repeatWarning(repeats),
      'Nothing about a parsed profile is guaranteed correct: read it against the original resume before tailoring from it.',
    ],
    next: [`sartor tailor prompt --profile ${q(out)} --posting posting.txt --pages 1`],
  };
}

export async function ingestRunCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the resume file', 'sartor ingest run <resume.pdf|docx|txt> --out profile.json');
  const out = str(ctx.flags.out) ?? 'profile.json';
  const { id, cfg } = providerConfig(ctx.io, str(ctx.flags.provider), str(ctx.flags.model));
  const { text } = await extract(ctx.io, path);
  ctx.io.stderr.write(`Structuring with ${id} ${cfg.model}…\n`);
  const result = await callProvider(() => ingestResume(text, getProvider(id), cfg, { label: str(ctx.flags.label) ?? basename(path, extname(path)) }));
  await writeOut(ctx.io, out, `${JSON.stringify(result.profile, null, 2)}\n`);
  const stats = profileStats(result.profile);
  const repeats = repeatsIn(result.profile, result.duplicates);
  return {
    data: { written: out, profile: stats, repeats, model: cfg.model },
    text: `Wrote ${out}: ${stats.name || '(no name)'} — ${stats.roles} roles, ${stats.projects} projects, ${stats.bullets} bullets.`,
    warnings: [...result.warnings, ...repeatWarning(repeats), 'Read the profile against the original resume before tailoring from it.'],
    next: [`sartor tailor run --profile ${q(out)} --posting posting.txt --pages 1`],
  };
}

/* ------------------------------------------------------------------ *
 * Tailoring
 * ------------------------------------------------------------------ */

function constraintsFrom(ctx: Ctx): TailorConstraints {
  return {
    pageTarget: parsePages(str(ctx.flags.pages)),
    tone: parseTone(str(ctx.flags.tone)),
    seniority: str(ctx.flags.seniority) ?? '',
  };
}

export async function tailorPromptCommand(ctx: Ctx): Promise<Result> {
  const profile = await loadProfile(ctx.io, str(ctx.flags.profile));
  const jd = await loadPosting(ctx.io, str(ctx.flags.posting));
  const constraints = constraintsFrom(ctx);
  const input = buildTailorUserPrompt(profile, jd, constraints);
  const p = q(str(ctx.flags.profile)!);
  const j = q(str(ctx.flags.posting)!);
  return promptResult(
    ctx,
    {
      task: 'Produce a tailoring plan for the posting below, following `instructions`, as JSON matching `schema` exactly. Write only the JSON to a file, then run the first command in `next`, with your file in place of plan.json. The plan selects and orders; it never invents.',
      instructions: TAILOR_SYSTEM_PROMPT,
      input,
      schema: TAILOR_PLAN_JSON_SCHEMA,
    },
    `# Instructions\n\n${TAILOR_SYSTEM_PROMPT}\n\n# Input\n\n${input}\n\n# Output\n\nJSON matching \`sartor schema plan\`.`,
    [`sartor tailor apply --profile ${p} --posting ${j} --plan plan.json --pages ${constraints.pageTarget} --out run.json`],
  );
}

/** The shared tail of `tailor apply` and `tailor run`: the run file, and what it says. */
async function finishRun(ctx: Ctx, file: RunFile, out: string, dropped: string[]): Promise<Result> {
  await writeRunFile(ctx.io, out, file);
  const summary = summarizeRun(file);
  const warnings = [...dropped];
  if (!summary.estimate.fits) {
    warnings.push(`Even trimmed as far as it will go, this needs ${summary.estimate.pages} pages against a target of ${summary.pageTarget}. Try a denser template (--template compact) or a 2-page target.`);
  }
  for (const { roleId, bulletId } of file.fit?.emptyRolesFilled ?? []) {
    const role = file.profile.work.find((w) => w.id === roleId);
    const bullet = role?.bullets.find((b) => b.id === bulletId);
    warnings.push(
      `The plan kept ${role ? `${role.position}, ${role.name}` : roleId} but left out every bullet, so its top-ranked one was put back rather than print a bare job title: "${bullet ? clip(bullet.text, 80) : bulletId}".`,
    );
  }
  if (summary.changes.blocking) {
    warnings.push(`${summary.changes.blocking} change(s) contain a name or number the profile does not have. They block rendering until each is rejected or acknowledged.`);
  }
  const r = q(out);
  return {
    data: { written: out, ...summary, fit: file.fit },
    text: [
      `Wrote ${out}.`,
      `Estimate: ${summary.estimate.pages} page(s) on ${summary.template} (target ${summary.pageTarget}), last page ${Math.round(summary.estimate.lastPageFill * 100)}% full.`,
      ...summary.entries.map((e) => `  ${e.section.padEnd(10)} ${e.name} — ${e.bullets} bullet${e.bullets === 1 ? '' : 's'}`),
      `Changes: ${summary.changes.total} (${summary.changes.blocking} blocking).`,
      summary.notes ? `\nNot supported by the profile: ${summary.notes}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    warnings,
    next: [`sartor review ${r}`, `sartor render ${r} --format pdf --out resume.pdf`],
  };
}

export async function tailorApplyCommand(ctx: Ctx): Promise<Result> {
  const profile = await loadProfile(ctx.io, str(ctx.flags.profile));
  const jd = await loadPosting(ctx.io, str(ctx.flags.posting));
  const planPath = str(ctx.flags.plan);
  if (!planPath) throw new CliError('missing_plan', 'No plan given.', 'Pass --plan <plan.json>: the JSON you wrote from `sartor tailor prompt`.', EXIT.usage);
  const constraints = constraintsFrom(ctx);
  const template = parseTemplate(str(ctx.flags.template));

  const parsed = tailorPlanSchema.safeParse(await readJson(ctx.io, planPath, 'the plan'));
  if (!parsed.success) {
    throw new CliError(
      'invalid_plan',
      `The plan does not match the plan schema: ${describeIssues(parsed.error.issues)}.`,
      'Fix those fields and run this again. `sartor schema plan` prints the schema.',
      EXIT.input,
      { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), message: i.message })) },
    );
  }

  // The same path the app takes: anything that does not point at the profile
  // is dropped, the page is fitted, and every change is checked by the guard.
  const { plan, dropped } = validatePlan(parsed.data, profile);
  const fitted = fitToTarget(profile, plan, constraints.pageTarget, template, jd.text);
  const run: TailorRun = {
    id: ids.run(),
    profileId: profile.id,
    createdAt: new Date().toISOString(),
    providerId: 'agent',
    model: str(ctx.flags['model-name']) ?? 'agent',
    jd,
    constraints,
    plan: fitted.plan,
    changes: buildChanges(profile, fitted.plan),
    notes: plan.notes,
  };
  const file: RunFile = { format: RUN_FORMAT, template: template.id, profile, run, modelPlan: plan, fit: summarizeFit(fitted) };
  return finishRun(ctx, file, str(ctx.flags.out) ?? 'run.json', dropped);
}

function summarizeFit(f: ReturnType<typeof fitToTarget>) {
  return { dropped: f.dropped, added: f.added, restoredSkills: f.restoredSkills, droppedEntries: f.droppedEntries, emptyRolesFilled: f.emptyRolesFilled, fits: f.fits, reinstated: f.reinstated };
}

/** Provider failures as CLI failures an agent can act on. */
async function callProvider<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ProviderError) {
      const hint = {
        auth: 'The API key was rejected. Check it, or use the agent workflow, which needs no key.',
        'rate-limit': 'The provider is rate-limiting this key, or the account is out of credit. Wait and retry, or check billing.',
        network: 'Could not reach the provider. Check the connection and retry.',
        'invalid-response': 'The model answered with something unusable. Retrying usually works.',
        unknown: 'Retry; if it keeps failing, use the agent workflow instead.',
      }[e.kind];
      throw new CliError(`provider_${e.kind.replace('-', '_')}`, e.message, hint, EXIT.provider);
    }
    throw e;
  }
}

export async function tailorRunCommand(ctx: Ctx): Promise<Result> {
  const profile = await loadProfile(ctx.io, str(ctx.flags.profile));
  const jd = await loadPosting(ctx.io, str(ctx.flags.posting));
  const constraints = constraintsFrom(ctx);
  const template = parseTemplate(str(ctx.flags.template));
  const { id, cfg } = providerConfig(ctx.io, str(ctx.flags.provider), str(ctx.flags.model));
  ctx.io.stderr.write(`Tailoring with ${id} ${cfg.model}…\n`);
  const outcome = await callProvider(() => runTailor(profile, jd, constraints, getProvider(id), cfg, { template }));
  const file: RunFile = {
    format: RUN_FORMAT,
    template: template.id,
    profile,
    run: outcome.run,
    modelPlan: outcome.modelPlan,
    fit: outcome.fit,
  };
  return finishRun(ctx, file, str(ctx.flags.out) ?? 'run.json', outcome.dropped);
}

/* ------------------------------------------------------------------ *
 * Review, render, check
 * ------------------------------------------------------------------ */

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function describeChange(c: Change): string {
  switch (c.kind) {
    case 'bullet-drop':
      return `leave out: "${clip(c.before)}"`;
    case 'entry-drop':
      return `leave out the whole entry`;
    case 'bullet-text':
      return `reword: "${clip(c.before, 60)}" → "${clip(c.after, 60)}"`;
    case 'summary':
      return `summary: "${clip(c.after)}"`;
    case 'skills':
      return `skills: ${clip(c.after)}`;
    default:
      return `${c.kind}: ${clip(c.after)}`;
  }
}

function changeView(c: Change, n: number, detailed: boolean) {
  const open = c.violations.filter((v) => !c.acknowledged.includes(v.id));
  const base = {
    n,
    id: c.id,
    kind: c.kind,
    where: c.label,
    change: describeChange(c),
    status: c.status,
    reviewed: c.reviewed,
    // The names and numbers the guard could not find in the profile.
    unverified: open.map((v) => v.token),
  };
  return detailed
    ? { ...base, before: c.before, after: c.after, rationale: c.rationale, violations: c.violations.map((v) => ({ token: v.token, message: v.message, acknowledged: c.acknowledged.includes(v.id) })) }
    : base;
}

export async function reviewCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the run file', 'sartor review <run.json> [--accept N] [--reject N] [--acknowledge N]');
  const file = await readRunFile(ctx.io, path);
  const changes = file.run.changes;

  const accept = resolveChanges(changes, list(ctx.flags.accept));
  const reject = resolveChanges(changes, list(ctx.flags.reject));
  const acknowledge = resolveChanges(changes, list(ctx.flags.acknowledge));
  const both = accept.filter((c) => reject.includes(c));
  if (both.length) {
    throw new CliError('conflicting_review', `Change ${changes.indexOf(both[0]!) + 1} is both accepted and rejected.`, 'Pass each change to one of --accept or --reject.', EXIT.usage);
  }

  for (const c of accept) Object.assign(c, { status: 'accepted', reviewed: true });
  for (const c of reject) Object.assign(c, { status: 'rejected', reviewed: true });
  // Vouching for a flagged name or number: the person says it is true and the
  // profile is missing it. Their call, never the agent's to make silently.
  for (const c of acknowledge) Object.assign(c, { acknowledged: c.violations.map((v) => v.id), reviewed: true });
  if (ctx.flags['accept-rest']) for (const c of changes) if (!c.reviewed) Object.assign(c, { status: 'accepted', reviewed: true });

  const mutated = accept.length + reject.length + acknowledge.length > 0 || Boolean(ctx.flags['accept-rest']);
  const out = str(ctx.flags.out) ?? path;
  if (mutated) await writeRunFile(ctx.io, out, file);

  const detailed = Boolean(ctx.flags.detailed);
  const views = changes.map((c, i) => changeView(c, i + 1, detailed));
  const blocking = blockingChanges(changes);
  const summary = summarizeRun(file);
  const r = q(out);
  return {
    data: { ...(mutated ? { written: out } : {}), changes: views, blocking: blocking.map((c) => changes.indexOf(c) + 1), estimate: summary.estimate },
    text: [
      ...views.map((v) => `${String(v.n).padStart(3)}. [${v.status === 'accepted' ? '✓' : '✗'}${v.reviewed ? '' : '?'}] ${v.where} — ${v.change}${v.unverified.length ? `  ⚠ not in profile: ${v.unverified.join(', ')}` : ''}`),
      '',
      `✓ accepted · ✗ rejected · ? not yet reviewed. ${blocking.length} blocking.`,
    ].join('\n'),
    warnings: blocking.length
      ? [`Changes ${blocking.map((c) => changes.indexOf(c) + 1).join(', ')} use a name or number the profile does not have. Reject them, or acknowledge them only if the person confirms they are true.`]
      : [],
    next: blocking.length
      ? [`sartor review ${r} --reject ${blocking.map((c) => changes.indexOf(c) + 1).join(',')}`]
      : [`sartor render ${r} --format pdf --out resume.pdf`],
  };
}

/** Pages in a PDF, from its page tree. The renderer writes exactly one. */
function pdfPageCount(bytes: Uint8Array): number {
  const m = /\/Count (\d+)/.exec(Buffer.from(bytes).toString('latin1'));
  return m ? Number(m[1]) : 0;
}

export async function renderCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the run file', 'sartor render <run.json> --format pdf|docx|txt --out <file>');
  const file = await readRunFile(ctx.io, path);
  const format = str(ctx.flags.format) ?? 'pdf';
  if (!['pdf', 'docx', 'txt'].includes(format)) {
    throw new CliError('invalid_format', `--format must be pdf, docx or txt, not ${JSON.stringify(format)}.`, 'Pass --format pdf, --format docx or --format txt.', EXIT.usage);
  }
  const template = str(ctx.flags.template) ? parseTemplate(str(ctx.flags.template)) : getTemplate(file.template);
  const out = str(ctx.flags.out) ?? `resume.${format}`;

  const blocking = blockingChanges(file.run.changes);
  if (blocking.length) {
    const numbers = blocking.map((c) => file.run.changes.indexOf(c) + 1);
    throw new CliError(
      'unverified_changes',
      `Not rendering: ${blocking.length} accepted change(s) use a name or number the profile does not have (changes ${numbers.join(', ')}).`,
      `Reject them with \`sartor review ${q(path)} --reject ${numbers.join(',')}\`, or acknowledge them only if the person confirms they are true.`,
      EXIT.blocked,
      { changes: blocking.map((c) => changeView(c, file.run.changes.indexOf(c) + 1, true)) },
    );
  }

  const doc = buildDocument(file.profile, file.run.plan, file.run.changes);
  let bytes: Uint8Array;
  let pages: number | null = null;
  try {
    if (format === 'txt') {
      bytes = new TextEncoder().encode(renderPlainText(doc));
    } else if (format === 'pdf') {
      const { renderPdfBlob } = await import('../core/render/pdf');
      bytes = new Uint8Array(await (await renderPdfBlob(doc, template)).arrayBuffer());
      pages = pdfPageCount(bytes);
    } else {
      const { renderDocxBlob } = await import('../core/render/docx');
      bytes = new Uint8Array(await (await renderDocxBlob(doc, template)).arrayBuffer());
    }
  } catch (e) {
    if (e instanceof Error && /Cannot find (package|module)/.test(e.message)) {
      const needs = format === 'pdf' ? 'react @react-pdf/renderer' : 'docx';
      throw new CliError('missing_dependency', `Rendering ${format.toUpperCase()} needs ${needs}, which is not installed.`, `Install it next to sartor: npm install ${needs}`, EXIT.input);
    }
    throw e;
  }
  await writeOut(ctx.io, out, bytes);

  const target = file.run.constraints.pageTarget;
  const overflow = pages !== null && pages > target;
  return {
    data: { written: out, format, template: template.id, ...(pages !== null ? { pages } : {}), pageTarget: target },
    text: `Wrote ${out}${pages !== null ? ` — ${pages} page${pages === 1 ? '' : 's'} (target ${target})` : ''}.`,
    warnings: overflow ? [`The PDF has ${pages} pages against a target of ${target}. Try --template compact, or re-run the tailoring with a 2-page target.`] : [],
    exit: overflow ? EXIT.blocked : EXIT.ok,
  };
}

export async function checkCommand(ctx: Ctx): Promise<Result> {
  const path = requirePositional(ctx, 0, 'the run file', 'sartor check <run.json>');
  const file = await readRunFile(ctx.io, path);
  const { profile, run } = file;
  const doc = buildDocument(profile, run.plan, run.changes);
  const summary = summarizeRun(file);
  const blocking = blockingChanges(run.changes);
  const parse = parseSafetyChecks(doc, run.constraints.pageTarget, getTemplate(file.template));
  const coverage = buildCoverage(run.jd.text, documentToSlices(doc), profile);
  const emphasised = coverage.terms.filter((t) => t.emphasised);

  const problems = [
    ...blocking.map((c) => `Change ${run.changes.indexOf(c) + 1} (${c.label}) uses ${c.violations.filter((v) => !c.acknowledged.includes(v.id)).map((v) => `"${v.token}"`).join(', ')}, which the profile does not have.`),
    ...(summary.estimate.fits ? [] : [`Estimated at ${summary.estimate.pages} pages against a target of ${summary.pageTarget}.`]),
    ...parse.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`),
  ];

  return {
    data: {
      ok: problems.length === 0,
      problems,
      estimate: summary.estimate,
      parseSafety: parse.map((c) => ({ check: c.id, status: c.status, detail: c.detail })),
      coverage: {
        // Terms the posting stressed, by what the resume does with them.
        onPage: emphasised.filter((t) => t.status === 'present').map((t) => t.term),
        inProfileNotOnPage: emphasised.filter((t) => t.status === 'in-profile').map((t) => t.term),
        notInProfile: emphasised.filter((t) => t.status === 'missing').map((t) => t.term),
      },
    },
    text: [
      problems.length ? `Problems:\n${problems.map((p) => `  - ${p}`).join('\n')}` : 'No problems.',
      `Estimate: ${summary.estimate.pages} page(s), last ${Math.round(summary.estimate.lastPageFill * 100)}% full (target ${summary.pageTarget}).`,
      `Posting terms on the page: ${emphasised.filter((t) => t.status === 'present').map((t) => t.term).join(', ') || 'none'}`,
      `In the profile but not on the page: ${emphasised.filter((t) => t.status === 'in-profile').map((t) => t.term).join(', ') || 'none'}`,
      `Not in the profile at all: ${emphasised.filter((t) => t.status === 'missing').map((t) => t.term).join(', ') || 'none'}`,
    ].join('\n'),
    exit: problems.length ? EXIT.blocked : EXIT.ok,
  };
}
