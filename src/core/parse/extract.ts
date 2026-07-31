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

export class ExtractionError extends Error {}

async function extractPdf(file: File): Promise<ExtractedText> {
  const pdfjs = await import('pdfjs-dist');
  // The worker ships with the app rather than being fetched from a CDN — a CDN
  // fetch would be a third-party request on a page holding the user's resume.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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

export async function extractResumeText(file: File): Promise<ExtractedText> {
  const name = file.name.toLowerCase();

  let extracted: ExtractedText;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    extracted = await extractPdf(file);
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
