/**
 * `sartor/render/pdf` — PDF rendering.
 *
 *   npm i @react-pdf/renderer react
 *
 * Deliberately separate from `sartor/render/docx`. A single `sartor/render`
 * barrel would mean anyone exporting a DOCX also pulls in the PDF engine —
 * several hundred kilobytes they never execute. Most consumers offer both
 * formats but render one at a time, so the split lets them load one at a time
 * too:
 *
 *   const { renderPdfBlob } = await import('sartor/render/pdf');
 *
 * Both renderers consume the same `ResumeDocument`, exported from the main
 * entry — which is why the two formats cannot say different things, and why you
 * can write a third renderer without depending on either of these.
 */

export { ResumePdf, renderPdfBlob } from '../core/render/pdf';
