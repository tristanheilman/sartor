/**
 * Text extraction from uploaded resumes. Runs entirely in the browser: the file
 * is read from a local `File` handle and never leaves the machine.
 */

import type { PDFPageProxy } from 'pdfjs-dist';
import { assembleLines, type PositionedText } from './layout';

export interface ExtractedText {
  text: string;
  /** Pages, for PDFs. Used only to warn about likely scanned documents. */
  pages: number;
  kind: 'pdf' | 'docx' | 'text';
}

export interface ExtractOptions {
  /**
   * URL of the pdf.js worker script, required for PDF input.
   *
   * There is no portable way for a library to locate this: every bundler wants
   * a different incantation, and each one is a compile-time transform rather
   * than something resolvable at runtime. So the caller supplies it, which
   * keeps bundler-specific syntax in application code where it belongs.
   *
   * Vite:      `import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`
   * webpack 5: `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href`
   * Node:      a `file://` URL to the file in node_modules
   *
   * Host it yourself rather than pointing at a CDN — a CDN fetch would be a
   * third-party request on a page holding the user's resume.
   */
  pdfWorkerSrc?: string;
}

export class ExtractionError extends Error {}

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

/**
 * `page.getTextContent()`, with the Safari trap routed around.
 *
 * pdf.js implements `getTextContent` as `for await (const chunk of
 * page.streamTextContent())`, and `streamTextContent()` hands back a plain
 * `ReadableStream`. Chrome and Firefox make those async-iterable; Safari does
 * not — desktop or iOS, current versions included. So the loop looks for a
 * `Symbol.asyncIterator` that is not there and JavaScriptCore throws
 * `undefined is not a function (near '...e of t...')` before a single character
 * of the resume comes out.
 *
 * Draining the stream through a reader is what `for await` desugars to anyway,
 * minus the assumption. We take this path on every browser rather than
 * feature-detecting, so the code that runs in Safari is the code the tests run.
 *
 * See the pinning test in `extract.test.ts`: if pdf.js ever fixes this
 * upstream, that test fails and this function can go.
 */
async function readTextContent(page: PDFPageProxy): Promise<TextContent> {
  const reader = page.streamTextContent().getReader();
  const content: TextContent = { items: [], styles: Object.create(null), lang: null };

  try {
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: TextContent };
      if (done) break;
      if (!value) continue;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
  } finally {
    reader.releaseLock();
  }

  return content;
}

async function extractPdf(file: File, opts: ExtractOptions): Promise<ExtractedText> {
  // pdf.js needs browser graphics primitives. Without this check a Node caller
  // gets `ReferenceError: DOMMatrix is not defined` from deep inside the
  // dependency, which says nothing about what to do next.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    throw new ExtractionError(
      'PDF extraction needs a browser environment — pdf.js depends on DOMMatrix and other DOM ' +
        'graphics primitives that Node does not provide. DOCX and plain-text extraction work ' +
        'anywhere. To read PDFs server-side, use the `pdfjs-dist/legacy` build directly.',
    );
  }

  const pdfjs = await import('pdfjs-dist');

  if (opts.pdfWorkerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = opts.pdfWorkerSrc;
  } else if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    throw new ExtractionError(
      'Reading a PDF needs the pdf.js worker. Pass `pdfWorkerSrc` to extractResumeText, ' +
        'or set pdfjs.GlobalWorkerOptions.workerSrc yourself. See ExtractOptions for the ' +
        'per-bundler incantation.',
    );
  }

  const buffer = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;

  const pageTexts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await readTextContent(page);

    // Reassembly is its own problem — columns, ligatures, reading order — and
    // lives in `layout.ts` where it can be tested without a PDF.
    const positioned: PositionedText[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      positioned.push({
        text: item.str,
        x: item.transform[4] as number,
        y: item.transform[5] as number,
        width: item.width,
        height: item.height,
      });
    }

    pageTexts.push(assembleLines(positioned).join('\n'));
  }

  return { text: pageTexts.join('\n\n'), pages: doc.numPages, kind: 'pdf' };
}

async function extractDocx(file: File): Promise<ExtractedText> {
  const mammoth = await import('mammoth');
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return { text: result.value, pages: 0, kind: 'docx' };
}

export async function extractResumeText(
  file: File,
  opts: ExtractOptions = {},
): Promise<ExtractedText> {
  const name = file.name.toLowerCase();

  let extracted: ExtractedText;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    extracted = await extractPdf(file, opts);
  } else if (name.endsWith('.docx') || file.type.includes('wordprocessingml')) {
    extracted = await extractDocx(file);
  } else if (name.endsWith('.txt') || name.endsWith('.md') || file.type.startsWith('text/')) {
    extracted = { text: await file.text(), pages: 0, kind: 'text' };
  } else if (name.endsWith('.doc')) {
    throw new ExtractionError(
      'Legacy .doc files are not supported. Save as .docx or PDF and try again.',
    );
  } else {
    throw new ExtractionError(`Unsupported file type: ${file.name}. Use PDF, DOCX, or plain text.`);
  }

  const words = extracted.text.trim().split(/\s+/).filter(Boolean).length;
  if (words < 40) {
    throw new ExtractionError(
      extracted.kind === 'pdf'
        ? 'Almost no text came out of that PDF. It is probably a scan or an image export — this tool cannot read those. Export a text-based PDF, or paste the text instead.'
        : 'That file contained almost no text. Try pasting the text instead.',
    );
  }

  return extracted;
}
