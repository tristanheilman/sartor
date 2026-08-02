import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ExtractionError, extractResumeText } from './extract';

/**
 * Text extraction, run against the real pdf.js and real files.
 *
 * These deliberately do not mock pdf.js. The bug that prompted them lives in
 * pdf.js's own `getTextContent`, so a mock of pdf.js would have asserted that
 * our stub behaves — which it always would.
 *
 * Fixtures come from `scripts/make-parse-fixtures.mjs`; regenerate with
 * `npm run fixtures:parse` if the expected text below needs to change.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const fixture = (name: string, type = '') =>
  new File([readFileSync(join(FIXTURES, name))], name, { type });

/** For the cases decided by file name alone, before anything is read. */
const named = (name: string) => new File(['irrelevant'], name);

// pdf.js falls back to its in-process worker when `Worker` is undefined, but
// `extractResumeText` insists on being told where the worker lives before it
// will touch a PDF. Point it at the real file, which is also the incantation
// `ExtractOptions` documents for Node.
const pdfWorkerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

const opts = { pdfWorkerSrc };

beforeAll(() => {
  // `extractPdf` refuses to run without browser graphics primitives. pdf.js
  // does not touch DOMMatrix on the text-extraction path, so a marker is enough
  // to get past the guard without pretending to implement it.
  globalThis.DOMMatrix ??= class {} as unknown as typeof DOMMatrix;
});

/**
 * Safari — desktop and iOS, current versions included — does not implement
 * `ReadableStream[Symbol.asyncIterator]`. Removing it is a faithful stand-in:
 * it is the exact capability the failing code reaches for, and the only one.
 */
const asyncIteratorDescriptor = Object.getOwnPropertyDescriptor(
  ReadableStream.prototype,
  Symbol.asyncIterator,
);

function withoutReadableStreamAsyncIteration<T>(fn: () => Promise<T>): Promise<T> {
  // @ts-expect-error -- removing a well-known symbol from a built-in prototype
  delete ReadableStream.prototype[Symbol.asyncIterator];
  return fn();
}

afterEach(() => {
  if (asyncIteratorDescriptor) {
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, asyncIteratorDescriptor);
  }
});

describe('extractResumeText, PDF', () => {
  it('pulls the text out of a text-based PDF', async () => {
    const { text, pages, kind } = await extractResumeText(fixture('resume.pdf'), opts);

    expect(kind).toBe('pdf');
    expect(pages).toBe(1);
    expect(text).toContain('Jordan Avery');
    expect(text).toContain('Staff Software Engineer, Northwind Payments');
    expect(text).toContain('cutting p99 write latency from 840ms to 95ms');
    expect(text).toContain('Go, TypeScript, Python, SQL');
  });

  it('keeps each line of the resume on its own line', async () => {
    const { text } = await extractResumeText(fixture('resume.pdf'), opts);
    const lines = text.split('\n');

    // Headings must not be run into the body text underneath them, and each
    // bullet must stay separate — this is what the caller splits on later.
    expect(lines).toContain('EXPERIENCE');
    expect(lines.filter((l) => l.startsWith('•'))).toHaveLength(5);
    expect(lines.indexOf('Jordan Avery')).toBeLessThan(lines.indexOf('EXPERIENCE'));
  });

  it('reads the same text in Safari, where ReadableStream is not async-iterable', async () => {
    const expected = (await extractResumeText(fixture('resume.pdf'), opts)).text;

    expect(asyncIteratorDescriptor).toBeDefined();
    const safari = await withoutReadableStreamAsyncIteration(() =>
      extractResumeText(fixture('resume.pdf'), opts),
    );

    expect(safari.text).toBe(expected);
  });

  it('explains that a scanned PDF cannot be read', async () => {
    await expect(extractResumeText(fixture('resume-scanned.pdf'), opts)).rejects.toThrow(
      ExtractionError,
    );
    await expect(extractResumeText(fixture('resume-scanned.pdf'), opts)).rejects.toThrow(/scan/i);
  });

  it('says what to do when no worker source is given', async () => {
    // `GlobalWorkerOptions` is module-global and every other test in this file
    // sets it, so clear it first — otherwise this passes or fails on test order.
    const pdfjs = await import('pdfjs-dist');
    const previous = pdfjs.GlobalWorkerOptions.workerSrc;
    pdfjs.GlobalWorkerOptions.workerSrc = '';

    try {
      await expect(extractResumeText(fixture('resume.pdf'))).rejects.toThrow(/pdfWorkerSrc/);
    } finally {
      pdfjs.GlobalWorkerOptions.workerSrc = previous;
    }
  });
});

/**
 * The upstream defect this all exists for, pinned in isolation.
 *
 * pdf.js implements `getTextContent()` as `for await (const chunk of
 * page.streamTextContent())`, and `streamTextContent()` returns a plain
 * `ReadableStream`. In Safari that stream has no `Symbol.asyncIterator`, so
 * JavaScriptCore throws `undefined is not a function (near '...e of t...')` —
 * the error a user sees instead of their resume. V8 words the same TypeError
 * differently, so this asserts on the type, not the wording.
 *
 * If this test starts failing, pdf.js has fixed it and `readTextContent` in
 * `extract.ts` can go away.
 */
describe('pdf.js getTextContent, the API we avoid', () => {
  it('throws in Safari, which is why extraction drains the stream itself', async () => {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

    const data = new Uint8Array(readFileSync(join(FIXTURES, 'resume.pdf')));
    const doc = await pdfjs.getDocument({ data }).promise;
    const page = await doc.getPage(1);

    // Works everywhere else.
    await expect(page.getTextContent()).resolves.toBeDefined();

    await expect(
      withoutReadableStreamAsyncIteration(() => page.getTextContent()),
    ).rejects.toThrow(TypeError);
  });
});

describe('extractResumeText, other formats', () => {
  it('reads a DOCX', async () => {
    const { text, kind } = await extractResumeText(fixture('resume.docx'));

    expect(kind).toBe('docx');
    expect(text).toContain('Jordan Avery');
    expect(text).toContain('Built a FHIR ingestion pipeline');
  });

  it('reads plain text', async () => {
    const { text, kind } = await extractResumeText(fixture('resume.txt', 'text/plain'));

    expect(kind).toBe('text');
    expect(text).toContain('University of Illinois');
  });

  it('rejects a file with almost no text in it', async () => {
    await expect(extractResumeText(fixture('too-short.txt', 'text/plain'))).rejects.toThrow(
      /almost no text/i,
    );
  });

  it('points .doc users at a format it can read', async () => {
    await expect(extractResumeText(named('resume.doc'))).rejects.toThrow(/\.docx or PDF/);
  });

  it('rejects an unsupported file type by name', async () => {
    await expect(extractResumeText(named('resume.rtf'))).rejects.toThrow(/Unsupported file type/);
  });
});
