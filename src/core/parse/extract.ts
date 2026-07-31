/**
 * Text extraction from uploaded resumes. Runs entirely in the browser: the file
 * is read from a local `File` handle and never leaves the machine.
 */

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
    const content = await page.getTextContent();

    // Reassemble lines by vertical position. Naive concatenation of text items
    // runs headings into body text and destroys bullet boundaries.
    const rows = new Map<number, Array<{ x: number; s: string }>>();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] as number);
      const x = item.transform[4] as number;
      const bucket = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      const row = rows.get(bucket) ?? [];
      row.push({ x, s: item.str });
      rows.set(bucket, row);
    }

    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left.
      .map(([, items]) =>
        items
          .sort((a, b) => a.x - b.x)
          .map((i) => i.s)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(Boolean);

    pageTexts.push(lines.join('\n'));
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
