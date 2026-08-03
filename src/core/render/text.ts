import type { ResumeDocument } from './model';

/**
 * Plain-text rendering.
 *
 * The third renderer, and the one that proves the point made in `model.ts`:
 * this file consumes the same `ResumeDocument` as the PDF and DOCX renderers
 * and depends on neither of them, so all three say the same thing without any
 * shared machinery beyond the document itself.
 *
 * Plain text is not a downgrade — it is the format application forms actually
 * want. When a site gives you a textarea labelled "paste your resume", the PDF
 * is useless and the DOCX is worse. So this output is built to survive that
 * paste: no box drawing, no alignment padding, no characters outside a
 * conservative set, and a blank line between blocks so the structure survives
 * even when a form collapses the whitespace.
 *
 * `documentToText` in `model.ts` looks similar and is not interchangeable: it
 * exists to give the fabrication guard one flat string to sweep, so it
 * deliberately drops headings, dates, and bullet markers. Reading it as a
 * resume would lose exactly the structure this renderer is here to keep.
 */

/** Dates and location on one line, as "10/2025 — Present · Remote". */
function metaLine(meta: string, aside: string): string {
  return [meta, aside].filter((s) => s && s.trim()).join(' · ');
}

export function renderPlainText(doc: ResumeDocument): string {
  const blocks: string[] = [];

  const head = [doc.contact.name, doc.contact.label, doc.contact.details.join(' · ')].filter(
    (l) => l && l.trim(),
  );
  blocks.push(head.join('\n'));

  for (const section of doc.sections) {
    const lines: string[] = [section.heading.toUpperCase()];

    if (section.kind === 'summary' && section.summary) {
      lines.push(section.summary);
    }

    if (section.kind === 'skills' && section.skills) {
      for (const g of section.skills) {
        lines.push(`${g.name}: ${g.keywords.join(', ')}`);
      }
    }

    if (section.kind === 'entries' && section.entries) {
      for (const e of section.entries) {
        // A blank line before every entry but the first, so roles do not run
        // together when a form strips the indentation.
        if (lines.length > 1) lines.push('');
        lines.push([e.primary, e.secondary].filter(Boolean).join(' — '));
        const meta = metaLine(e.meta, e.aside);
        if (meta) lines.push(meta);
        if (e.summary) lines.push(e.summary);
        for (const b of e.bullets) lines.push(`- ${b.text}`);
      }
    }

    if (section.kind === 'list' && section.items) {
      for (const i of section.items) lines.push(`- ${i.text}`);
    }

    // A heading with nothing under it is worse than no heading at all.
    if (lines.length > 1) blocks.push(lines.join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}

export function renderTextBlob(doc: ResumeDocument): Blob {
  return new Blob([renderPlainText(doc)], { type: 'text/plain;charset=utf-8' });
}
