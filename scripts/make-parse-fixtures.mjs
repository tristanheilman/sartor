/**
 * Regenerates the resume fixtures under `src/core/parse/__fixtures__/`.
 *
 *   node scripts/make-parse-fixtures.mjs
 *
 * The fixtures are committed, because generating them on every test run would
 * make the parse tests depend on the renderers they are supposed to be
 * independent of. This script exists so they are reproducible rather than
 * opaque binaries someone dropped in years ago — if a fixture needs to change,
 * change it here.
 *
 * Reproducible in content, not byte-for-byte: the PDFs carry a creation
 * timestamp, so rerunning this always shows a diff even when nothing changed.
 * Only commit regenerated fixtures when you meant to change them.
 *
 * The content is invented. Nothing here is anyone's real resume.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import React from 'react';
import { Document, Page, Text, View, Image, StyleSheet, pdf } from '@react-pdf/renderer';
import { Document as DocxDocument, Packer, Paragraph, TextRun } from 'docx';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/core/parse/__fixtures__');
mkdirSync(OUT, { recursive: true });

const h = React.createElement;

/** The one source of truth for what the fixtures say, so tests can assert against it. */
const RESUME = {
  name: 'Jordan Avery',
  label: 'Senior Software Engineer',
  contact: 'jordan.avery@example.com | (555) 010-4477 | Austin, TX',
  summary:
    'Backend engineer with nine years building payment and identity systems at scale. ' +
    'Comfortable owning a service end to end, from schema design through on-call.',
  roles: [
    {
      company: 'Northwind Payments',
      title: 'Staff Software Engineer',
      dates: 'March 2021 - Present',
      bullets: [
        'Led the migration of the settlement ledger to a sharded design, cutting p99 write latency from 840ms to 95ms.',
        'Designed an idempotency layer that eliminated duplicate captures.',
        'Mentored four engineers, two of whom were promoted to senior.',
      ],
    },
    {
      company: 'Cobalt Health',
      title: 'Senior Software Engineer',
      dates: 'June 2018 - February 2021',
      bullets: [
        'Built a FHIR ingestion pipeline handling 40 million records per day.',
        'Reduced infrastructure spend 31 percent by rightsizing Kubernetes workloads.',
      ],
    },
  ],
  education: 'University of Illinois at Urbana-Champaign, BS Computer Science, 2016',
  skills: 'Go, TypeScript, Python, SQL, Kubernetes, Terraform, AWS, Postgres, Kafka',
};

/** Same words as the PDF, as flat lines. The plain-text fixture and the DOCX. */
const RESUME_LINES = [
  RESUME.name,
  RESUME.label,
  RESUME.contact,
  'SUMMARY',
  RESUME.summary,
  'EXPERIENCE',
  ...RESUME.roles.flatMap((r) => [`${r.title}, ${r.company}`, r.dates, ...r.bullets]),
  'EDUCATION',
  RESUME.education,
  'SKILLS',
  RESUME.skills,
];

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, lineHeight: 1.4, color: '#111111' },
  name: { fontSize: 19 },
  label: { fontSize: 11, color: '#333333' },
  contact: { fontSize: 9, color: '#444444', marginBottom: 12 },
  section: { fontSize: 11, marginTop: 12, marginBottom: 4 },
  roleTitle: { fontSize: 10, marginTop: 6 },
  dates: { fontSize: 9, color: '#555555' },
  bullet: { marginTop: 2, paddingLeft: 10 },
});

/**
 * A text-based resume. Single column, text in reading order — the shape the
 * extractor is built for.
 */
function TextResume() {
  return h(
    Document,
    null,
    h(
      Page,
      { size: 'LETTER', style: styles.page },
      h(Text, { style: styles.name }, RESUME.name),
      h(Text, { style: styles.label }, RESUME.label),
      h(Text, { style: styles.contact }, RESUME.contact),
      h(Text, { style: styles.section }, 'SUMMARY'),
      h(Text, null, RESUME.summary),
      h(Text, { style: styles.section }, 'EXPERIENCE'),
      ...RESUME.roles.map((r, i) =>
        h(
          View,
          { key: i },
          h(Text, { style: styles.roleTitle }, `${r.title}, ${r.company}`),
          h(Text, { style: styles.dates }, r.dates),
          ...r.bullets.map((b, j) => h(Text, { key: j, style: styles.bullet }, `• ${b}`)),
        ),
      ),
      h(Text, { style: styles.section }, 'EDUCATION'),
      h(Text, null, RESUME.education),
      h(Text, { style: styles.section }, 'SKILLS'),
      h(Text, null, RESUME.skills),
    ),
  );
}

/**
 * A two-column resume: main column left, skills-and-contact sidebar right.
 *
 * The layout that broke extraction. A sidebar shares vertical positions with
 * the main column, so bucketing text by its y coordinate alone interleaves the
 * two — an employer line and a GitHub URL land on one line. It is also an
 * extremely common resume template, so this belongs in the fixtures as a real
 * PDF rather than only as synthetic coordinates in a unit test.
 */
function TwoColumnResume() {
  const side = { fontSize: 8.5, marginBottom: 3, color: '#333333' };
  return h(
    Document,
    null,
    h(
      Page,
      { size: 'LETTER', style: { padding: 40, flexDirection: 'row', fontSize: 10 } },
      // Main column
      h(
        View,
        { style: { flex: 2, paddingRight: 26 } },
        h(Text, { style: { fontSize: 18 } }, RESUME.name),
        h(Text, { style: { fontSize: 10.5, color: '#333333', marginBottom: 10 } }, RESUME.label),
        h(Text, { style: { fontSize: 10.5, marginBottom: 4 } }, 'EXPERIENCE'),
        ...RESUME.roles.flatMap((r, i) => [
          h(Text, { key: `t${i}`, style: { marginTop: 6 } }, `${r.title}, ${r.company}`),
          h(Text, { key: `d${i}`, style: { fontSize: 9, color: '#555555' } }, r.dates),
          ...r.bullets.map((b, j) =>
            h(Text, { key: `b${i}-${j}`, style: { marginTop: 2, paddingLeft: 8 } }, `• ${b}`),
          ),
        ]),
        h(Text, { style: { fontSize: 10.5, marginTop: 12, marginBottom: 4 } }, 'EDUCATION'),
        h(Text, null, RESUME.education),
      ),
      // Sidebar
      h(
        View,
        { style: { flex: 1, borderLeftWidth: 0.5, borderLeftColor: '#CCCCCC', paddingLeft: 16 } },
        h(Text, { style: { fontSize: 10.5, marginBottom: 4 } }, 'CONTACT'),
        ...RESUME.contact.split(' | ').map((line, i) => h(Text, { key: `c${i}`, style: side }, line)),
        h(Text, { style: { fontSize: 10.5, marginTop: 12, marginBottom: 4 } }, 'SKILLS'),
        ...RESUME.skills.split(', ').map((sk, i) => h(Text, { key: `s${i}`, style: side }, sk)),
      ),
    ),
  );
}

/**
 * A greyscale PNG of nothing in particular, as a stand-in for a page scan.
 * Hand-rolled so the fixtures need no image assets of their own.
 */
function greyPng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale

  // One filter byte per row, then a faint horizontal banding so the image is
  // not a single flat colour a renderer might optimise away.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 0;
    raw.fill(y % 24 < 12 ? 0xf4 : 0xe8, row + 1, row + 1 + width);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF whose page is one image and no text at all — a scan or a photo export. */
function ScannedResume(pngDataUri) {
  return h(
    Document,
    null,
    h(
      Page,
      { size: 'LETTER', style: { padding: 0 } },
      h(Image, { src: pngDataUri, style: { width: '100%', height: '100%' } }),
    ),
  );
}

async function writePdf(element, name) {
  const buffer = await pdf(element).toBuffer();
  const chunks = [];
  for await (const chunk of buffer) chunks.push(chunk);
  const out = Buffer.concat(chunks);
  writeFileSync(join(OUT, name), out);
  console.log(`${name}  ${out.length} bytes`);
}

await writePdf(h(TextResume), 'resume.pdf');
await writePdf(h(TwoColumnResume), 'resume-two-column.pdf');
await writePdf(
  ScannedResume(`data:image/png;base64,${greyPng(612, 792).toString('base64')}`),
  'resume-scanned.pdf',
);

const docx = await Packer.toBuffer(
  new DocxDocument({
    sections: [
      {
        children: RESUME_LINES.map(
          (line) => new Paragraph({ children: [new TextRun({ text: line })] }),
        ),
      },
    ],
  }),
);
writeFileSync(join(OUT, 'resume.docx'), docx);
console.log(`resume.docx  ${docx.length} bytes`);

writeFileSync(join(OUT, 'resume.txt'), RESUME_LINES.join('\n') + '\n');
console.log('resume.txt written');

// A file with real words but too few of them, for the "almost no text" guard.
writeFileSync(join(OUT, 'too-short.txt'), 'Jordan Avery\nSoftware Engineer\nAustin, TX\n');
console.log('too-short.txt written');
