/**
 * Runs a resume all the way through the pipeline and writes down everything it
 * did.
 *
 *   npm run audit -- --pdf path/to/resume.pdf
 *   npm run audit -- --profile p.json --plan plan.json --jd posting.txt
 *
 * The output is a numbered directory: every stage's input beside its output,
 * every model request beside its response, and a `report.md` tying them
 * together. You can open the final PDF, and you can see exactly what produced
 * each line of it.
 *
 * Two things make this an audit rather than a demo:
 *
 *   1. **It imports the built package**, not `src/`. Same entry points a
 *      stranger would use, which keeps the audit honest about what the library
 *      can actually do — and continuously checks the published surface, for the
 *      reason `docs/ARCHITECTURE.md` gives.
 *
 *   2. **Every stage records why it did or did not run.** A stage that was
 *      skipped for want of an API key says so in the report, with the request
 *      it would have sent. Silence would be indistinguishable from success.
 *
 * Stages that need a model are skipped unless a key is present. Supply a stage's
 * output yourself (`--profile`, `--plan`) to run past it without one.
 */

import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire, register } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* --- running a browser library under Node ------------------------------ *
 * `extractResumeText` imports `pdfjs-dist` by bare specifier — correct for a
 * browser library — so Node would get the modern build, which needs platform
 * features that do not exist before Node 22. The hook redirects it to the
 * `legacy` build pdf.js ships for this, the same way `vitest.config.ts` does
 * for the test run. Must be registered before `dist/` is imported. */
register('./pdfjs-legacy-hook.mjs', import.meta.url);

/* pdf.js does not touch DOMMatrix on the text-extraction path, but
 * `extractPdf` guards on it to give Node callers a usable error instead of a
 * stack trace from three layers down. A marker satisfies the guard. */
globalThis.DOMMatrix ??= class DOMMatrix {};

/* --- args -------------------------------------------------------------- */

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  if (key) args[key] = process.argv[i + 1];
}

if (!args.pdf && !args.profile) {
  console.error(
    'usage: npm run audit -- --pdf <resume.pdf> [--jd <posting.txt>] [--profile <p.json>] [--plan <plan.json>] [--out <dir>]',
  );
  process.exit(1);
}

/**
 * The key, from the environment or from a gitignored `.env`.
 *
 * `.env` is already in `.gitignore` — see the note there. It is read here so a
 * key can be supplied once, to a file, rather than pasted into a shell history
 * or a chat log. It is never written to the run directory and never printed.
 */
function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    return /^ANTHROPIC_API_KEY\s*=\s*(.+)$/m.exec(env)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  } catch {
    return '';
  }
}

const apiKey = readApiKey();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const label = args.label ?? (args.pdf ? basename(args.pdf, '.pdf') : 'run');
const OUT = resolve(args.out ?? join(ROOT, 'evals/runs', `${stamp}-${label}`));
mkdirSync(OUT, { recursive: true });

/* --- the ledger -------------------------------------------------------- */

const steps = [];

function record(step) {
  steps.push(step);
  const mark = { ran: '✓', skipped: '–', blocked: '✗' }[step.status];
  console.log(`${mark} ${step.id} ${step.name}${step.note ? ` — ${step.note}` : ''}`);
}

const write = (name, body) => {
  writeFileSync(join(OUT, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return name;
};

/* --- the pipeline ------------------------------------------------------ */

const jdTextEarly = args.jd ? readFileSync(resolve(args.jd), 'utf8') : '';

const lib = await import(pathToFileURL(join(ROOT, 'dist/index.js')).href);
const parse = await import(pathToFileURL(join(ROOT, 'dist/parse.js')).href);
const renderPdf = await import(pathToFileURL(join(ROOT, 'dist/render/pdf.js')).href);

const pdfWorkerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

// --- 00 input
if (args.pdf) {
  copyFileSync(resolve(args.pdf), join(OUT, '00-input.pdf'));
  record({ id: '00', name: 'input', status: 'ran', outputs: ['00-input.pdf'], note: basename(args.pdf) });
}

// --- 01 extract
let extracted = null;
if (args.pdf) {
  const bytes = readFileSync(resolve(args.pdf));
  const file = new File([bytes], basename(args.pdf), { type: 'application/pdf' });
  extracted = await parse.extractResumeText(file, { pdfWorkerSrc });

  const lines = extracted.text.split('\n');
  write('01-extracted.txt', extracted.text);
  write('01-extract-meta.json', {
    pages: extracted.pages,
    kind: extracted.kind,
    words: extracted.text.trim().split(/\s+/).length,
    lines: lines.length,
    longestLine: Math.max(...lines.map((l) => l.length)),
    // A line this long usually means two columns were merged into one.
    suspiciouslyLongLines: lines.filter((l) => l.length > 160).length,
  });

  record({
    id: '01',
    name: 'extract text',
    status: 'ran',
    outputs: ['01-extracted.txt', '01-extract-meta.json'],
    note: `${extracted.text.trim().split(/\s+/).length} words, ${lines.length} lines`,
  });
}

// --- 02 ingest (model)
let profile = null;
if (args.profile) {
  profile = lib.profileSchema.parse(JSON.parse(readFileSync(resolve(args.profile), 'utf8')));
  write('02-profile.json', profile);
  record({ id: '02', name: 'structure into a profile', status: 'skipped', outputs: ['02-profile.json'], note: `supplied via --profile` });
} else if (extracted) {
  const request = {
    system: parse.INGEST_SYSTEM_PROMPT,
    user: `Convert this resume into the JSON structure.\n\n---\n${extracted.text}\n---`,
    jsonSchema: { name: 'resume_profile', schema: parse.INGEST_JSON_SCHEMA },
  };
  write('02-ingest.request.json', request);

  if (!apiKey) {
    record({
      id: '02',
      name: 'structure into a profile',
      status: 'blocked',
      outputs: ['02-ingest.request.json'],
      note: 'no ANTHROPIC_API_KEY — request written but not sent',
    });
  } else {
    const provider = lib.getProvider('anthropic');
    const result = await provider.complete(request, { apiKey, model: args.model ?? 'claude-sonnet-5' });
    write('02-ingest.response.json', { text: result.text, usage: result.usage, model: result.model });
    const ingested = parse.rawToProfile(result.json, label);
    profile = ingested;
    write('02-profile.json', profile);
    record({ id: '02', name: 'structure into a profile', status: 'ran', outputs: ['02-ingest.request.json', '02-ingest.response.json', '02-profile.json'], note: `${result.usage.inputTokens} in / ${result.usage.outputTokens} out` });
  }
}

// --- 03 interview
//
// The one stage where new facts enter. Gaps are computed deterministically;
// the model only phrases the question and transcribes the answer. Answers come
// from --answers (a JSON map of gapId -> what the person said), which is how
// this is exercised without a human sitting here.
if (profile) {
  const gaps = lib.findGaps(profile, { jdText: jdTextEarly, limit: Number(args.questions ?? 8) });
  write('03-gaps.json', gaps);

  const answers = args.answers
    ? JSON.parse(readFileSync(resolve(args.answers), 'utf8'))
    : null;

  if (!apiKey || !answers) {
    record({
      id: '03',
      name: 'gap interview',
      status: 'blocked',
      outputs: ['03-gaps.json'],
      note: !answers ? `${gaps.length} gaps found — pass --answers to run the interview` : 'no ANTHROPIC_API_KEY',
    });
  } else {
    mkdirSync(join(OUT, '03-interview'), { recursive: true });
    const provider = lib.getProvider('anthropic');
    const cfg = { apiKey, model: args.model ?? 'claude-sonnet-5' };

    const asked = await provider.complete(
      {
        system: lib.INTERVIEW_SYSTEM_PROMPT,
        user: lib.buildQuestionsPrompt(profile, gaps),
        jsonSchema: { name: 'questions', schema: lib.QUESTIONS_JSON_SCHEMA },
      },
      cfg,
    );
    const questions = lib.questionsSchema.parse(asked.json).questions;

    const turns = [];
    const drafted = [];
    const newRoles = [];
    const endedRoles = [];
    let draftedSummary = '';
    let n = 0;

    for (const q of questions) {
      const gap = gaps.find((g) => g.id === q.gapId);
      const answer = answers[q.gapId];
      n += 1;
      const file = `03-interview/q${String(n).padStart(2, '0')}.json`;

      if (!gap || !answer) {
        write(file, { gap, question: q, answer: null, skipped: 'no answer supplied', bullets: [] });
        turns.push({ n, gapId: q.gapId, answered: false, produced: 0 });
        continue;
      }

      const reply = await provider.complete(
        {
          system: lib.INTERVIEW_SYSTEM_PROMPT,
          user: lib.buildAnswerPrompt(gap, q.question, answer, profile),
          jsonSchema: { name: 'bullets', schema: lib.DRAFTED_BULLETS_JSON_SCHEMA },
        },
        cfg,
      );
      const parsed = lib.draftedBulletsSchema.parse(reply.json);
      // A summary describes a career, so nothing from that question belongs
      // under a job — enforced here as well as asked for, because the model
      // can ignore an instruction and the merge cannot tell the difference.
      const bullets = gap.kind === 'no-summary' ? [] : parsed.bullets;
      if (gap.kind === 'no-summary' && parsed.summary.trim()) draftedSummary = parsed.summary.trim();
      // An answer can describe a job the profile has never heard of.
      if (parsed.newRole?.name?.trim()) newRoles.push({ role: parsed.newRole, gapId: gap.id });
      if (parsed.endedRole?.ownerId?.trim() && parsed.endedRole?.endDate?.trim()) {
        endedRoles.push(parsed.endedRole);
      }

      // Everything about this turn in one file: why it was asked, what was
      // asked, what was said, and precisely what that produced.
      write(file, {
        gap,
        question: q,
        answer,
        bullets,
        newRole: parsed.newRole?.name?.trim() ? parsed.newRole : null,
        summary: gap.kind === 'no-summary' ? parsed.summary : '',
        droppedBullets: gap.kind === 'no-summary' ? parsed.bullets.length : 0,
        endedRole: parsed.endedRole?.ownerId?.trim() ? parsed.endedRole : null,
        remainingAfter: lib.remainingGaps(gaps, [answer]).length,
      });
      drafted.push(...bullets.map((b) => ({ ...b, gapId: gap.id, ownerId: b.ownerId || gap.ownerId || '' })));
      turns.push({ n, gapId: q.gapId, answered: true, produced: bullets.length, newRole: parsed.newRole?.name || null });
    }

    write('03-turns.json', turns);

    // --- 04 merge the answers back in, through the ordinary merge pipeline
    const asBullets = (list) =>
      list.filter((b) => b.text.trim()).map((b) => ({ id: lib.ids.bullet(), text: b.text.trim(), tags: [], variants: [] }));

    // Existing roles keep their identity so `planMerge` matches them; anything
    // the answers described as a new job becomes a new entry, which the merge
    // adds with freshly minted IDs.
    const incomingWork = profile.work.map((w) => {
      // A departure the interview heard becomes a proposed date correction,
      // which planMerge surfaces rather than applying silently.
      const ended = endedRoles.find((e) => e.ownerId === w.id);
      return {
        ...w,
        endDate: ended ? ended.endDate : w.endDate,
        bullets: asBullets(drafted.filter((b) => b.ownerId === w.id)),
      };
    });

    for (const { role } of newRoles) {
      incomingWork.push({
        id: lib.ids.work(),
        name: role.name,
        position: role.position,
        location: role.location,
        startDate: role.startDate,
        endDate: role.endDate,
        summary: '',
        tags: [],
        bullets: asBullets(drafted.filter((b) => b.ownerId === 'new')),
      });
    }

    const incoming = lib.profileSchema.parse({
      ...lib.emptyProfile(lib.ids.profile()),
      // The summary goes through planMerge's field-level basics path, so an
      // existing one is a conflict the user resolves rather than an overwrite.
      basics: { ...profile.basics, summary: draftedSummary || profile.basics.summary },
      work: incomingWork,
    });

    const mergePlan = parse.planMerge(profile, incoming);
    write('04-merge-plan.json', mergePlan);
    write('04-merge-summary.json', parse.summarizeMerge(mergePlan));

    profile = parse.applyMerge(profile, mergePlan, { sourceLabel: 'gap interview' });
    write('04-profile-after.json', profile);

    const before = profile.work.reduce((t, w) => t + w.bullets.length, 0);
    record({
      id: '03',
      name: 'gap interview',
      status: 'ran',
      outputs: ['03-gaps.json', '03-turns.json', '03-interview/'],
      note: `${turns.filter((t) => t.answered).length} answered, ${drafted.length} bullets drafted${newRoles.length ? `, ${newRoles.length} new role(s)` : ''}${draftedSummary ? ', summary written' : ''}`,
    });
    record({
      id: '04',
      name: 'merge answers into the profile',
      status: 'ran',
      outputs: ['04-merge-plan.json', '04-merge-summary.json', '04-profile-after.json'],
      note: `${before} work bullets, ${parse.summarizeMerge(mergePlan).datesCorrected} date(s) corrected`,
    });
  }
} else {
  record({ id: '03', name: 'gap interview', status: 'blocked', outputs: [], note: 'no profile' });
}

// --- 05 tailor (model)
const jdText = jdTextEarly;
let plan = null;

if (args.plan) {
  plan = lib.tailorPlanSchema.parse(JSON.parse(readFileSync(resolve(args.plan), 'utf8')));
  write('05-plan.json', plan);
  record({ id: '05', name: 'tailoring plan', status: 'skipped', outputs: ['05-plan.json'], note: 'supplied via --plan' });
} else if (profile && jdText && apiKey) {
  // --repeat samples the model's nondeterminism. Same profile, same posting,
  // k independent calls — which is the only honest way to record a case, since
  // one recording pins a single roll of the dice and calls it the behaviour.
  const repeat = Math.max(1, Number(args.repeat ?? 1));
  const constraints = { ...lib.DEFAULT_CONSTRAINTS, pageTarget: Number(args.pages ?? 1) };

  write('05-tailor.request.json', {
    system: lib.TAILOR_SYSTEM_PROMPT,
    user: lib.buildTailorUserPrompt(profile, lib.fromPaste(jdText), constraints),
  });

  const recorded = [];
  for (let i = 1; i <= repeat; i++) {
    const outcome = await lib.runTailor(
      profile,
      lib.fromPaste(jdText),
      constraints,
      lib.getProvider('anthropic'),
      { apiKey, model: args.model ?? 'claude-sonnet-5' },
    );
    const name = repeat === 1 ? '05-plan.json' : `05-plans/${String(i).padStart(2, '0')}.json`;
    if (repeat > 1) mkdirSync(join(OUT, '05-plans'), { recursive: true });
    write(name, outcome.run.plan);
    recorded.push({ n: i, dropped: outcome.dropped.length, plan: outcome.run.plan });
    if (i === 1) write('05-tailor.response.json', outcome.run);
  }

  plan = recorded[0].plan;

  // Report the spread here too, so an expensive recording session tells you
  // immediately whether the selector is stable enough to iterate against.
  const kept = recorded.map(
    (r) => r.plan.work.filter((w) => w.include).length + '/' + r.plan.work.length,
  );
  record({
    id: '05',
    name: 'tailoring plan',
    status: 'ran',
    outputs: repeat === 1 ? ['05-plan.json'] : ['05-plans/'],
    note: repeat === 1 ? `${recorded[0].dropped} dropped as unreal` : `${repeat} recordings, roles kept: ${kept.join(' ')}`,
  });
} else {
  record({
    id: '05',
    name: 'tailoring plan',
    status: 'blocked',
    outputs: [],
    note: !profile ? 'no profile' : !jdText ? 'no --jd' : 'no ANTHROPIC_API_KEY',
  });
}

// --- 06/07 changes, guard, document
let doc = null;
if (profile && plan) {
  const { plan: valid, dropped } = lib.validatePlan(plan, profile);
  if (dropped.length) write('06-dropped-by-validation.json', dropped);

  const changes = lib.buildChanges(profile, valid);
  const lexicon = lib.profileLexicon(profile);

  // Each change beside the guard's verdict on it. This is the provenance trail:
  // every generated line, the profile fact it came from, and whether every
  // proper noun and number in it traces back to the profile.
  write(
    '06-changes.json',
    changes.map((c) => ({
      ...c,
      guard: c.after ? lib.checkText(c.after, lexicon, c.kind) : null,
    })),
  );

  doc = lib.buildDocument(profile, valid, changes);
  write('07-document.json', doc);

  record({
    id: '06',
    name: 'changes + fabrication guard',
    status: 'ran',
    outputs: ['06-changes.json'],
    note: `${changes.length} changes, ${dropped.length} dropped by validation`,
  });
  record({ id: '07', name: 'build document', status: 'ran', outputs: ['07-document.json'] });
} else {
  record({ id: '06', name: 'changes + fabrication guard', status: 'blocked', outputs: [], note: 'needs a profile and a plan' });
}

// --- 08/09 render and read back
if (doc) {
  const blob = await renderPdf.renderPdfBlob(doc, args.template ?? 'classic');
  const bytes = Buffer.from(await blob.arrayBuffer());
  writeFileSync(join(OUT, '08-resume.pdf'), bytes);

  const back = await parse.extractResumeText(
    new File([bytes], 'resume.pdf', { type: 'application/pdf' }),
    { pdfWorkerSrc },
  );
  write('09-extracted-back.txt', back.text);

  // Everything that went in has to come back out, or the document is
  // unreadable to whatever parses it next.
  const flat = back.text.replace(/\s+/g, ' ');
  // Every piece of generated prose, not just the bullets. A hyphen inserted
  // at a line break mangled a summary for three runs while this reported zero
  // losses, because summaries were never in the set being checked.
  const passages = [
    ...doc.sections.filter((s) => s.summary).map((s) => ({ where: 'summary', text: s.summary })),
    ...doc.sections
      .flatMap((s) => s.entries ?? [])
      .flatMap((e) => e.bullets.map((b) => ({ where: 'bullet', text: b.text }))),
  ];
  const missing = passages.filter((p) => !flat.includes(p.text.replace(/\s+/g, ' ')));

  write('09-roundtrip.json', {
    passagesChecked: passages.length,
    passagesLost: missing.length,
    lost: missing,
    hyphenBreaks: (back.text.match(/[A-Za-z]{3,}-\n/g) ?? []).length,
  });

  const coverage = jdText ? lib.buildCoverage(jdText, lib.documentToSlices(doc), profile) : null;
  if (coverage) write('10-coverage.json', coverage);

  const safety = lib.parseSafetyChecks(doc, Number(args.pages ?? 1));
  write('10-parse-safety.json', safety);

  record({ id: '08', name: 'render PDF', status: 'ran', outputs: ['08-resume.pdf'], note: `${(bytes.length / 1024).toFixed(0)} KB` });
  record({
    id: '09',
    name: 'read the PDF back',
    status: missing.length ? 'blocked' : 'ran',
    outputs: ['09-extracted-back.txt', '09-roundtrip.json'],
    note: missing.length ? `${missing.length} passage(s) did not survive` : `all ${passages.length} passages survived`,
  });
  record({ id: '10', name: 'coverage + parse safety', status: 'ran', outputs: coverage ? ['10-coverage.json', '10-parse-safety.json'] : ['10-parse-safety.json'] });
} else {
  record({ id: '08', name: 'render PDF', status: 'blocked', outputs: [], note: 'no document to render' });
}

/* --- the report -------------------------------------------------------- */

const line = (s) =>
  `| ${s.id} | ${s.name} | ${{ ran: '✓ ran', skipped: '– supplied', blocked: '✗ blocked' }[s.status]} | ${s.note ?? ''} | ${s.outputs.map((o) => `[${o}](${o})`).join('<br>') || '—'} |`;

const blocked = steps.filter((s) => s.status === 'blocked');

write(
  'report.md',
  `# Pipeline audit — ${label}

Run at ${new Date().toISOString()}${apiKey ? '' : ' · **no API key present**'}

Every stage below, in order, with what it produced. Files are relative to this
directory.

| # | stage | status | notes | artifacts |
|---|---|---|---|---|
${steps.map(line).join('\n')}

${
  blocked.length
    ? `## Why this run stopped short\n\n${blocked
        .map((s) => `- **${s.id} ${s.name}** — ${s.note}`)
        .join('\n')}\n\nStages needing a model are skipped without \`ANTHROPIC_API_KEY\`. Supply a stage's output directly (\`--profile\`, \`--plan\`) to run past it.`
    : '## Complete\n\nEvery stage ran.'
}

## Reading this

- \`01-extracted.txt\` is what the extractor made of the input PDF. If a resume
  is two-column or scanned, this is where it shows.
- \`06-changes.json\` is the provenance trail: each generated line, the profile
  fact it derives from, and the guard's verdict on every proper noun and number
  in it.
- \`08-resume.pdf\` is the artifact. \`09-extracted-back.txt\` is that same file
  read back by the same extractor — if a bullet is missing there, it is missing
  for every downstream parser too.
`,
);

console.log(`\n${OUT}\n`);
