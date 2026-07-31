import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from 'docx';
import type { ResumeDocument, DocSection } from './model';
import { getTemplate, type Template } from './templates';

/**
 * DOCX rendering.
 *
 * Same document model, same rules: one column of ordinary paragraphs, real
 * heading styles, contact details as body text. Some employers ask for DOCX
 * specifically, and some ATS parse it more reliably than PDF, so both formats
 * are first-class rather than one being a lossy afterthought.
 *
 * Right-aligned dates use a tab stop, not a table. A table here would look
 * identical and parse considerably worse.
 */

const PT = 2; // docx half-points
const TWIP_PER_INCH = 1440;
const CONTENT_WIDTH = TWIP_PER_INCH * 6.5; // Letter minus 1" margins.

function run(text: string, t: Template, opts: { bold?: boolean; size?: number; color?: string } = {}) {
  return new TextRun({
    text,
    bold: opts.bold,
    color: opts.color,
    font: t.docxFont,
    size: Math.round((opts.size ?? t.baseSize) * PT),
  });
}

function heading(text: string, t: Template): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: t.sectionGap * 10, after: 60 },
    border: t.headingRule
      ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '999999', space: 2 } }
      : undefined,
    children: [
      run(t.uppercaseHeadings ? text.toUpperCase() : text, t, { bold: true, size: t.baseSize * 1.05 }),
    ],
  });
}

/** A left/right line built from a tab stop rather than a two-column table. */
function splitLine(
  left: TextRun[],
  right: string,
  t: Template,
  spacing: { before?: number; after?: number } = {},
): Paragraph {
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
    spacing,
    children: right ? [...left, new TextRun({ text: '\t' }), run(right, t, { color: '444444' })] : left,
  });
}

function sectionParagraphs(section: DocSection, t: Template): Paragraph[] {
  const out: Paragraph[] = [heading(section.heading, t)];

  if (section.kind === 'summary' && section.summary) {
    out.push(new Paragraph({ children: [run(section.summary, t)] }));
    return out;
  }

  if (section.kind === 'skills') {
    for (const g of section.skills ?? []) {
      out.push(
        new Paragraph({
          spacing: { after: 40 },
          children: [run(`${g.name}: `, t, { bold: true }), run(g.keywords.join(', '), t)],
        }),
      );
    }
    return out;
  }

  if (section.kind === 'list') {
    for (const i of section.items ?? []) {
      out.push(new Paragraph({ spacing: { after: 40 }, children: [run(i.text, t)] }));
    }
    return out;
  }

  for (const e of section.entries ?? []) {
    out.push(
      splitLine([run(e.primary, t, { bold: true, size: t.baseSize * 1.02 })], e.meta, t, {
        before: t.entryGap * 10,
      }),
    );
    if (e.secondary || e.aside) {
      out.push(splitLine([run(e.secondary, t)], e.aside, t, { after: 40 }));
    }
    if (e.summary) out.push(new Paragraph({ spacing: { after: 40 }, children: [run(e.summary, t)] }));
    for (const b of e.bullets) {
      out.push(
        new Paragraph({
          numbering: { reference: 'sartor-bullets', level: 0 },
          spacing: { after: t.bulletGap * 12 },
          children: [run(b.text, t)],
        }),
      );
    }
  }

  return out;
}

export function buildDocxDocument(doc: ResumeDocument, templateId: string): Document {
  const t = getTemplate(templateId);

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      spacing: { after: 40 },
      children: [run(doc.contact.name, t, { bold: true, size: t.baseSize * 1.9 })],
    }),
  ];

  if (doc.contact.label) {
    children.push(
      new Paragraph({ spacing: { after: 40 }, children: [run(doc.contact.label, t, { color: '333333' })] }),
    );
  }

  if (doc.contact.details.length > 0) {
    // Body text, not a header — a DOCX header is frequently dropped entirely by
    // text extraction.
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [run(doc.contact.details.join('  ·  '), t, { color: '333333', size: t.baseSize * 0.95 })],
      }),
    );
  }

  for (const section of doc.sections) children.push(...sectionParagraphs(section, t));

  return new Document({
    creator: 'Sartor',
    title: `${doc.contact.name} — Resume`,
    numbering: {
      config: [
        {
          reference: 'sartor-bullets',
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: '•',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 300, hanging: 200 } } },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: t.docxFont, size: Math.round(t.baseSize * PT) } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children,
      },
    ],
  });
}

export async function renderDocxBlob(doc: ResumeDocument, templateId: string): Promise<Blob> {
  return Packer.toBlob(buildDocxDocument(doc, templateId));
}
