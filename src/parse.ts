/**
 * `sartor/parse` — resume ingestion.
 *
 * Split out because of the extraction dependencies, declared as optional peers:
 *
 *   npm i pdfjs-dist   # for PDF input
 *   npm i mammoth      # for DOCX input
 *
 * `extractResumeText` needs a `pdfWorkerSrc` for PDFs — see `ExtractOptions`
 * for why a library cannot resolve that for you.
 *
 * A note on `ingestResume`: it returns a profile plus a list of warnings, and
 * it is meant to be shown to the user for correction before you save it.
 * Extraction is lossy, and a silent error here propagates into every document
 * generated from that profile — the fabrication guard cannot help you, because
 * it will faithfully ground everything in a profile that is already wrong.
 */

export {
  extractResumeText,
  ExtractionError,
  type ExtractedText,
  type ExtractOptions,
} from './core/parse/extract';

export {
  ingestResume,
  rawToProfile,
  INGEST_SYSTEM_PROMPT,
  INGEST_JSON_SCHEMA,
  type IngestResult,
} from './core/parse/ingest';
