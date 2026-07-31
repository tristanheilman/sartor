/**
 * `sartor/render/docx` — DOCX rendering.
 *
 *   npm i docx
 *
 * Separate from `sartor/render/pdf` so that offering both formats does not mean
 * shipping both engines. See the note in `pdf.ts`.
 *
 * Some employers ask for DOCX specifically, and some applicant-tracking systems
 * extract it more reliably than PDF, so this is a first-class output rather
 * than a lossy afterthought. It is built from the same `ResumeDocument`.
 */

export { buildDocxDocument, renderDocxBlob } from '../core/render/docx';
