import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './main';
import type { Io } from './io';

/**
 * The CLI, driven the way an agent drives it: arguments in, one JSON envelope
 * out on stdout, an exit code that says what kind of outcome it was.
 *
 * In-process, with the streams captured, so the whole pipeline — validation,
 * the fit pass, the fabrication guard, rendering — runs exactly as it does
 * from the shell, without building or spawning anything.
 */

const CASE = join(dirname(fileURLToPath(import.meta.url)), '../../evals/cases/platform-stretch');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** stdout parsed, when it is JSON. */
  json: any;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sartor-cli-'));
});

async function sartor(args: string[], opts: { tty?: boolean; stdin?: string } = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: { write: (s: string) => (stdout += s), isTTY: opts.tty ?? false },
    stderr: { write: (s: string) => (stderr += s) },
    stdin: Object.assign(
      (async function* () {
        if (opts.stdin !== undefined) yield opts.stdin;
      })(),
      { isTTY: opts.stdin === undefined },
    ),
    cwd,
    env: {},
  };
  const code = await main(args, io, '0.0.0-test');
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, stdout, stderr, json };
}

const profile = join(CASE, 'profile.json');
const posting = join(CASE, 'posting.txt');
const plan = join(CASE, 'plans', '01.json');

async function applied(extra: string[] = []) {
  return sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', plan, '--pages', '1', '--out', 'run.json', ...extra]);
}

describe('talking to an agent', () => {
  it('answers in one JSON envelope when stdout is not a terminal', async () => {
    const r = await sartor(['templates']);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command: 'templates' });
    expect(r.json.data.map((t: { id: string }) => t.id)).toContain('classic');
  });

  it('answers in text at a terminal, and in JSON there when asked', async () => {
    expect((await sartor(['templates'], { tty: true })).json).toBeUndefined();
    expect((await sartor(['templates', '--json'], { tty: true })).json.ok).toBe(true);
    expect((await sartor(['templates', '--human'])).json).toBeUndefined();
  });

  it('reports failure as an envelope with a code, a message and a hint', async () => {
    const r = await sartor(['tailor', 'apply', '--profile', 'missing.json', '--posting', posting, '--plan', plan]);
    expect(r.code).toBe(3);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatchObject({ code: 'file_not_found' });
    expect(r.json.error.hint).toBeTruthy();
    // And a person still sees it, on stderr.
    expect(r.stderr).toMatch(/Could not read the profile/);
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    const r = await sartor(['tailor', 'apply', '--profle', profile]);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('invalid_arguments');
  });

  it('names the subcommands when given only the first word', async () => {
    const r = await sartor(['tailor']);
    expect(r.code).toBe(2);
    expect(r.json.error.hint).toMatch(/tailor prompt, tailor apply, tailor run/);
  });

  it('never mistakes a flag value for a command', async () => {
    const r = await sartor(['tailor', 'prompt', '--profile', profile, '--posting', posting, '--seniority', 'review']);
    expect(r.code).toBe(0);
    expect(r.json.command).toBe('tailor prompt');
  });

  it('describes each command on --help', async () => {
    const r = await sartor(['render', '--help']);
    expect(r.code).toBe(0);
    expect(r.json.data.usage).toMatch(/^sartor render/);
  });
});

describe('the agent workflow', () => {
  it('hands the agent instructions, input and schema for a plan', async () => {
    const r = await sartor(['tailor', 'prompt', '--profile', profile, '--posting', posting, '--pages', '1']);
    expect(r.code).toBe(0);
    expect(Object.keys(r.json.data)).toEqual(['task', 'instructions', 'input', 'schema']);
    expect(r.json.data.input).toMatch(/Riley Okafor/);
    expect(r.json.data.schema.required).toContain('requested');
    expect(r.json.next[0]).toMatch(/^sartor tailor apply/);
  });

  it('reads the posting from stdin', async () => {
    const r = await sartor(['tailor', 'prompt', '--profile', profile, '--posting', '-'], { stdin: readFileSync(posting, 'utf8') });
    expect(r.code).toBe(0);
    expect(r.json.data.input).toMatch(/Kubernetes/);
  });

  it('checks the plan, fits it and writes a run file', async () => {
    const r = await applied();
    expect(r.code).toBe(0);
    expect(r.json.data.estimate).toMatchObject({ pages: 1, fits: true });
    expect(r.json.data.entries.map((e: { name: string }) => e.name)).toContain('Senior Backend Engineer, Harbor Freight Systems');
    const file = JSON.parse(readFileSync(join(cwd, 'run.json'), 'utf8'));
    expect(file.format).toBe('sartor.run/1');
    expect(file.profile.basics.name).toBe('Riley Okafor');
  });

  it('says exactly where a plan is wrong', async () => {
    writeFileSync(join(cwd, 'bad.json'), JSON.stringify({ summary: 'not an object' }));
    const r = await sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', 'bad.json']);
    expect(r.code).toBe(3);
    expect(r.json.error.code).toBe('invalid_plan');
    expect(r.json.error.details.issues[0].path).toBe('summary');
  });

  it('drops plan entries that do not point at the profile, and says so', async () => {
    const p = JSON.parse(readFileSync(plan, 'utf8'));
    p.work.push({ id: 'wrk_invented', include: true, order: 9, bullets: [] });
    writeFileSync(join(cwd, 'plan.json'), JSON.stringify(p));
    const r = await sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', 'plan.json', '--out', 'run.json']);
    expect(r.code).toBe(0);
    expect(r.json.warnings.join(' ')).toMatch(/wrk_invented/);
  });
});

describe('reviewing and rendering', () => {
  it('lists changes by number and records a rejection', async () => {
    await applied();
    const listed = await sartor(['review', 'run.json']);
    expect(listed.json.data.changes[0]).toMatchObject({ n: 1, status: 'accepted', reviewed: false });

    const r = await sartor(['review', 'run.json', '--reject', '1']);
    expect(r.code).toBe(0);
    const file = JSON.parse(readFileSync(join(cwd, 'run.json'), 'utf8'));
    expect(file.run.changes[0]).toMatchObject({ status: 'rejected', reviewed: true });
  });

  it('refuses a change number that does not exist', async () => {
    await applied();
    const r = await sartor(['review', 'run.json', '--reject', '99']);
    expect(r.code).toBe(2);
    expect(r.json.error.code).toBe('unknown_change');
  });

  it('renders text, DOCX and a one-page PDF', async () => {
    await applied();
    const txt = await sartor(['render', 'run.json', '--format', 'txt', '--out', 'resume.txt']);
    expect(txt.code).toBe(0);
    expect(readFileSync(join(cwd, 'resume.txt'), 'utf8')).toMatch(/Riley Okafor/);

    const docx = await sartor(['render', 'run.json', '--format', 'docx', '--out', 'resume.docx']);
    expect(docx.code).toBe(0);
    expect(existsSync(join(cwd, 'resume.docx'))).toBe(true);

    const pdf = await sartor(['render', 'run.json', '--format', 'pdf', '--out', 'resume.pdf']);
    expect(pdf.code).toBe(0);
    expect(pdf.json.data).toMatchObject({ pages: 1, pageTarget: 1 });
  });

  describe('a summary naming something the profile does not have', () => {
    // The trap in this case: the posting wants Kubernetes; the profile has
    // none. A plan whose summary claims it must not reach a rendered file.
    const fabricated = async () => {
      const p = JSON.parse(readFileSync(plan, 'utf8'));
      p.summary = { text: 'Backend engineer who runs Go services on Kubernetes.', rationale: 'Matches the posting.' };
      writeFileSync(join(cwd, 'plan.json'), JSON.stringify(p));
      return sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', 'plan.json', '--out', 'run.json']);
    };

    it('is flagged when the run is written', async () => {
      const r = await fabricated();
      expect(r.code).toBe(0);
      expect(r.json.data.changes.blocking).toBe(1);
    });

    it('stops render, naming the change and how to clear it', async () => {
      await fabricated();
      const r = await sartor(['render', 'run.json', '--format', 'txt', '--out', 'resume.txt']);
      expect(r.code).toBe(5);
      expect(r.json.error.code).toBe('unverified_changes');
      expect(r.json.error.hint).toMatch(/--reject/);
      expect(existsSync(join(cwd, 'resume.txt'))).toBe(false);
    });

    it('stops check too', async () => {
      await fabricated();
      const r = await sartor(['check', 'run.json']);
      expect(r.code).toBe(5);
      expect(r.json.data.problems[0]).toMatch(/Kubernetes/);
    });

    it('renders once the change is rejected, without the claim', async () => {
      await fabricated();
      const n = (await sartor(['review', 'run.json'])).json.data.blocking[0];
      await sartor(['review', 'run.json', '--reject', String(n)]);
      const r = await sartor(['render', 'run.json', '--format', 'txt', '--out', 'resume.txt']);
      expect(r.code).toBe(0);
      expect(readFileSync(join(cwd, 'resume.txt'), 'utf8')).not.toMatch(/Kubernetes/);
    });
  });
});

describe('structuring a resume', () => {
  const structured = {
    basics: { name: 'Dana Reyes', label: 'Engineer', email: 'dana@example.com', phone: '', url: '', summary: '', city: '', region: '', profiles: [] },
    work: [{ name: 'Acme', position: 'Engineer', location: '', startDate: '2020', endDate: '2024', summary: '', bullets: [{ text: 'Shipped the billing service.', restates: 0 }] }],
    education: [],
    projects: [],
    skills: [{ name: 'Languages', keywords: ['Go'] }],
    certificates: [],
    awards: [],
  };

  it('turns the agent\'s structured resume into a profile', async () => {
    writeFileSync(join(cwd, 'structured.json'), JSON.stringify(structured));
    const r = await sartor(['ingest', 'apply', 'structured.json', '--out', 'profile.json']);
    expect(r.code).toBe(0);
    expect(r.json.data.profile).toMatchObject({ name: 'Dana Reyes', roles: 1, bullets: 1 });
    expect(JSON.parse(readFileSync(join(cwd, 'profile.json'), 'utf8')).work[0].bullets[0].text).toBe('Shipped the billing service.');
  });

  it('reports bullets the structuring flagged as said twice, with both wordings', async () => {
    const repeated = {
      ...structured,
      work: [{
        ...structured.work[0],
        bullets: [
          { text: 'Shipped the billing service.', restates: 0 },
          { text: 'Built and shipped the billing service to production.', restates: 1 },
        ],
      }],
    };
    writeFileSync(join(cwd, 'structured.json'), JSON.stringify(repeated));
    const r = await sartor(['ingest', 'apply', 'structured.json', '--out', 'profile.json']);
    expect(r.code).toBe(0);
    expect(r.json.data.repeats).toEqual([
      expect.objectContaining({ entry: 'Acme', texts: ['Shipped the billing service.', 'Built and shipped the billing service to production.'] }),
    ]);
    expect(r.json.warnings.join(' ')).toMatch(/same fact said twice/);
    // Both stay until the person decides.
    expect(JSON.parse(readFileSync(join(cwd, 'profile.json'), 'utf8')).work[0].bullets).toHaveLength(2);
  });

  it('says which field is wrong', async () => {
    writeFileSync(join(cwd, 'structured.json'), JSON.stringify({ ...structured, work: 'Acme' }));
    const r = await sartor(['ingest', 'apply', 'structured.json']);
    expect(r.code).toBe(3);
    expect(r.json.error.details.issues[0].path).toBe('work');
  });

  it('reads text resumes for the prompt', async () => {
    writeFileSync(join(cwd, 'resume.txt'), 'Dana Reyes\nEngineer at Acme, 2020 - 2024\n- Shipped the billing service.');
    const r = await sartor(['ingest', 'prompt', 'resume.txt']);
    expect(r.code).toBe(0);
    expect(r.json.data.input).toMatch(/Shipped the billing service/);
    expect(r.json.data.schema.properties.work).toBeTruthy();
  });
});

describe('bring your own key', () => {
  it('says which variable the key is read from, and offers the keyless workflow', async () => {
    const r = await sartor(['tailor', 'run', '--profile', profile, '--posting', posting]);
    expect(r.code).toBe(4);
    expect(r.json.error.code).toBe('missing_api_key');
    expect(r.json.error.hint).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.json.error.hint).toMatch(/tailor prompt/);
  });
});

describe('schemas', () => {
  it.each(['profile', 'plan', 'structured-resume'])('prints the %s schema', async (which) => {
    const r = await sartor(['schema', which]);
    expect(r.code).toBe(0);
    expect(r.json.data.type).toBe('object');
  });
});
