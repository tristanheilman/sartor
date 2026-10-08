import { parseArgs, type ParseArgsConfig } from 'node:util';
import { CliError, EXIT, emit, emitError, wantsJson, type Io, type Result } from './io';
import * as cmd from './commands';

/**
 * `sartor` — the tailoring pipeline as commands an agent can drive.
 *
 * Two ways to run the steps that need a language model:
 *
 *   - **Agent workflow.** `ingest prompt` and `tailor prompt` print the
 *     instructions, the input and the JSON Schema; the calling agent — Claude
 *     Code, or anything else — does the model's part and writes the JSON; and
 *     `ingest apply` and `tailor apply` take it from there. No API key: the
 *     reasoning happens in whatever session the agent already has.
 *   - **Bring your own key.** `ingest run` and `tailor run` make the call
 *     themselves, with a key from the environment.
 *
 * Either way the result lands in the same place and goes through the same
 * checks the app applies: anything that does not point at the profile is
 * dropped, the page is fitted, and every generated line is checked for names
 * and numbers the profile does not contain. `render` refuses while such a line
 * is accepted and unacknowledged.
 */

type Options = NonNullable<ParseArgsConfig['options']>;

interface Command {
  name: string;
  summary: string;
  usage: string;
  /** What it does, for `--help`: what an agent needs to use it correctly. */
  help: string;
  options: Options;
  run: (ctx: cmd.Ctx) => Promise<Result>;
}

const profileOpt = { profile: { type: 'string' } } as const;
const postingOpt = { posting: { type: 'string' } } as const;
const pagesOpt = { pages: { type: 'string' } } as const;
const toneOpt = { tone: { type: 'string' }, seniority: { type: 'string' } } as const;
const templateOpt = { template: { type: 'string' } } as const;
const outOpt = { out: { type: 'string' } } as const;
const providerOpt = { provider: { type: 'string' }, model: { type: 'string' } } as const;

export const COMMANDS: Command[] = [
  {
    name: 'extract',
    summary: 'Read the text out of a resume file',
    usage: 'sartor extract <resume.pdf|docx|txt> [--out text.txt]',
    help: 'Reads a PDF, DOCX or text resume the way the app does, including two-column layouts. Prints the text, or writes it with --out.',
    options: { ...outOpt },
    run: cmd.extractCommand,
  },
  {
    name: 'ingest prompt',
    summary: 'Instructions and schema for structuring a resume (agent workflow)',
    usage: 'sartor ingest prompt <resume.pdf|docx|txt> [--out prompt.json]',
    help: 'Prints the instructions, the resume text and the JSON Schema for turning a resume into a structured profile — or writes them to a file with --out, which needs no shell redirect. Do what `task` says: write JSON matching `schema`, transcribing literally, then run `sartor ingest apply` on it.',
    options: { ...outOpt },
    run: cmd.ingestPromptCommand,
  },
  {
    name: 'ingest apply',
    summary: 'Turn a structured resume into a profile (agent workflow)',
    usage: 'sartor ingest apply <structured.json|-> [--out profile.json] [--label name]',
    help: 'Validates JSON written from `sartor ingest prompt` and writes the profile every later command reads. A field that does not match the schema is reported by path.',
    options: { ...outOpt, label: { type: 'string' } },
    run: cmd.ingestApplyCommand,
  },
  {
    name: 'ingest run',
    summary: 'Structure a resume with your own API key',
    usage: 'sartor ingest run <resume.pdf|docx|txt> [--provider anthropic|openai|google] [--model id] [--out profile.json]',
    help: 'Extracts and structures a resume in one step, calling the provider with a key from ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY.',
    options: { ...outOpt, ...providerOpt, label: { type: 'string' } },
    run: cmd.ingestRunCommand,
  },
  {
    name: 'tailor prompt',
    summary: 'Instructions and schema for a tailoring plan (agent workflow)',
    usage: 'sartor tailor prompt --profile profile.json --posting posting.txt [--pages 1|2] [--tone plain|impact|technical] [--seniority text] [--out prompt.json]',
    help: 'Prints the instructions, the profile and posting, and the JSON Schema for a tailoring plan — or writes them to a file with --out, which needs no shell redirect. The plan selects and orders bullets the profile already has; it never introduces a name, number or technology the profile lacks. Write it as JSON matching `schema`, then run `sartor tailor apply`.',
    options: { ...profileOpt, ...postingOpt, ...pagesOpt, ...toneOpt, ...outOpt },
    run: cmd.tailorPromptCommand,
  },
  {
    name: 'tailor apply',
    summary: 'Check a plan, fit it to the page, and write a run file (agent workflow)',
    usage: 'sartor tailor apply --profile profile.json --posting posting.txt --plan plan.json [--pages 1|2] [--template classic] [--out run.json]',
    help: 'Validates the plan against the profile, trims or fills it to the page target as the app does, checks every generated line for names and numbers the profile lacks, and writes a run file. Include more than fits: the fit pass cuts from the end of the plan\'s order.',
    options: { ...profileOpt, ...postingOpt, ...pagesOpt, ...toneOpt, ...templateOpt, ...outOpt, plan: { type: 'string' }, 'model-name': { type: 'string' } },
    run: cmd.tailorApplyCommand,
  },
  {
    name: 'tailor run',
    summary: 'Tailor with your own API key',
    usage: 'sartor tailor run --profile profile.json --posting posting.txt [--pages 1|2] [--template classic] [--provider anthropic] [--model id] [--out run.json]',
    help: 'Makes the model call itself, with a key from the environment, then does everything `tailor apply` does.',
    options: { ...profileOpt, ...postingOpt, ...pagesOpt, ...toneOpt, ...templateOpt, ...outOpt, ...providerOpt },
    run: cmd.tailorRunCommand,
  },
  {
    name: 'review',
    summary: 'List a run\'s changes; accept, reject or acknowledge them',
    usage: 'sartor review <run.json> [--accept 1,2] [--reject 3] [--acknowledge 4] [--accept-rest] [--detailed] [--out run.json]',
    help: 'Lists every change the run makes to the profile, numbered. Changes are accepted by default; --reject puts a line back as it was. A change marked "not in profile" uses a name or number the profile lacks: reject it, or --acknowledge it only if the person confirms it is true. Writes the run file back in place unless --out is given.',
    options: {
      accept: { type: 'string', multiple: true },
      reject: { type: 'string', multiple: true },
      acknowledge: { type: 'string', multiple: true },
      'accept-rest': { type: 'boolean' },
      detailed: { type: 'boolean' },
      ...outOpt,
    },
    run: cmd.reviewCommand,
  },
  {
    name: 'render',
    summary: 'Write the resume as PDF, DOCX or text',
    usage: 'sartor render <run.json> [--format pdf|docx|txt] [--template id] [--out resume.pdf]',
    help: 'Renders the run with the template it was fitted to. Refuses while an accepted change uses a name or number the profile lacks (exit 5). For a PDF, reports the page count and exits 5 if it exceeds the target.',
    options: { format: { type: 'string' }, ...templateOpt, ...outOpt },
    run: cmd.renderCommand,
  },
  {
    name: 'check',
    summary: 'What would stop this run from being sent',
    usage: 'sartor check <run.json>',
    help: 'Reports unverified names and numbers, the page estimate, parse-safety checks, and which of the posting\'s stressed terms are on the page, in the profile only, or missing. Exits 5 when there is a problem.',
    options: {},
    run: cmd.checkCommand,
  },
  {
    name: 'schema',
    summary: 'Print a JSON Schema',
    usage: 'sartor schema <profile|plan|structured-resume>',
    help: 'The JSON Schema for a profile, a tailoring plan, or a structured resume.',
    options: {},
    run: cmd.schemaCommand,
  },
  {
    name: 'templates',
    summary: 'List the resume templates',
    usage: 'sartor templates',
    help: 'Every built-in template: id, name, typeface and size. Denser templates hold more on a page.',
    options: {},
    run: cmd.templatesCommand,
  },
];

const GLOBAL: Options = {
  json: { type: 'boolean' },
  human: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
};

function topHelp(version: string): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return `sartor ${version} — tailor a resume to a job posting without inventing anything.

Usage: sartor <command> [options]

Commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`).join('\n')}

Agent workflow (no API key; the calling agent writes the JSON):
  sartor ingest prompt resume.pdf --out ingest-prompt.json
                                              → write structured.json
  sartor ingest apply structured.json --out profile.json
  sartor tailor prompt --profile profile.json --posting posting.txt --pages 1 --out tailor-prompt.json
                                              → write plan.json
  sartor tailor apply --profile profile.json --posting posting.txt --plan plan.json --out run.json
  sartor review run.json                      → show the changes; --reject any that are wrong
  sartor render run.json --format pdf --out resume.pdf

Output: one JSON envelope on stdout when piped or with --json; text at a terminal or with --human.
  { ok, command, data, warnings?, next?, error?: { code, message, hint } }
Exit codes: 0 ok · 1 internal error · 2 usage · 3 bad input · 4 provider · 5 blocked (unverified change, page target missed)

Run \`sartor <command> --help\` for a command's options.`;
}

function commandHelp(c: Command): string {
  return `${c.usage}\n\n${c.help}`;
}

/**
 * The command is the leading word or two, before any flag — so a flag's value
 * can never be mistaken for a command. Two words are tried before one, so
 * `tailor apply` is not read as `tailor` with an argument.
 */
function findCommand(argv: string[]): { command: Command | undefined; rest: string[] } {
  for (const length of [2, 1]) {
    const lead = argv.slice(0, length);
    if (lead.length < length || lead.some((w) => w.startsWith('-'))) continue;
    const command = COMMANDS.find((c) => c.name === lead.join(' '));
    if (command) return { command, rest: argv.slice(length) };
  }
  return { command: undefined, rest: argv };
}

export async function main(argv: string[], io: Io, version: string): Promise<number> {
  const { command, rest } = findCommand(argv);
  const label = command?.name ?? argv.filter((a) => !a.startsWith('-')).slice(0, 1).join(' ');

  let flags: Record<string, string | boolean | string[] | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...(command?.options ?? {}) }, allowPositionals: true, strict: true });
    flags = parsed.values as typeof flags;
    positionals = parsed.positionals;
  } catch (e) {
    const json = argv.includes('--json') || (!argv.includes('--human') && !io.stdout.isTTY);
    emitError(io, json, label || 'sartor', new CliError('invalid_arguments', e instanceof Error ? e.message : String(e), command ? `Usage: ${command.usage}` : 'Run `sartor --help` for the commands.', EXIT.usage));
    return EXIT.usage;
  }

  const json = wantsJson(io, flags as { json?: boolean; human?: boolean });

  if (flags.version) {
    emit(io, json, 'version', { data: { version }, text: version });
    return EXIT.ok;
  }
  if (!command) {
    if (flags.help || positionals.length === 0) {
      emit(io, json, 'help', { data: { version, commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage })) }, text: topHelp(version) });
      return positionals.length === 0 && !flags.help ? EXIT.usage : EXIT.ok;
    }
    const related = COMMANDS.filter((c) => c.name.startsWith(`${label} `)).map((c) => c.name);
    emitError(
      io,
      json,
      label,
      related.length
        ? new CliError('incomplete_command', `"${label}" needs a subcommand.`, `Use one of: ${related.join(', ')}.`, EXIT.usage)
        : new CliError('unknown_command', `There is no command called ${JSON.stringify(label)}.`, `Commands: ${COMMANDS.map((c) => c.name).join(', ')}.`, EXIT.usage),
    );
    return EXIT.usage;
  }
  if (flags.help) {
    emit(io, json, command.name, { data: { usage: command.usage, help: command.help, options: Object.keys(command.options) }, text: commandHelp(command) });
    return EXIT.ok;
  }

  try {
    const result = await command.run({ io, positionals, flags });
    emit(io, json, command.name, result);
    return result.exit ?? EXIT.ok;
  } catch (e) {
    if (e instanceof CliError) {
      emitError(io, json, command.name, e);
      return e.exit;
    }
    const message = e instanceof Error ? e.message : String(e);
    emitError(io, json, command.name, new CliError('internal_error', `Sartor failed unexpectedly: ${message}`, 'This is a bug in sartor. Re-run with the same inputs and report it with the command line.', EXIT.internal));
    return EXIT.internal;
  }
}
