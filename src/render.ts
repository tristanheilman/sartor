/**
 * `sartor/render` — deterministic PDF and DOCX rendering.
 *
 * Split out because these carry the heavy dependencies. They are declared as
 * optional peers, so installing `sartor` for the guard alone does not drag in
 * a PDF engine.
 *
 *   npm i @react-pdf/renderer react   # for renderPdfBlob / ResumePdf
 *   npm i docx                        # for renderDocxBlob / buildDocxDocument
 *
 * Both renderers consume the same `ResumeDocument`, which is why the two
 * formats cannot drift apart. `ResumeDocument` itself is exported from the
 * main entry, so you can write your own renderer instead.
 */

export { ResumePdf, renderPdfBlob } from './core/render/pdf';
export { buildDocxDocument, renderDocxBlob } from './core/render/docx';
