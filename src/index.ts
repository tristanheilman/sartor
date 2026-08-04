/**
 * `sartor` — the public API.
 *
 * This entry point is dependency-light on purpose: everything here needs only
 * `zod`. The heavy, optional pieces live behind subpaths, so using the
 * fabrication guard does not pull a PDF renderer into your bundle:
 *
 *   `sartor`         schema, tailoring, guard, coverage, providers, doc model
 *   `sartor/render`  PDF and DOCX renderers   (peer: react, @react-pdf/renderer, docx)
 *   `sartor/parse`   resume ingestion         (peer: pdfjs-dist, mammoth)
 *
 * Everything exported here is covered by semver. Anything reachable by deep
 * import is not — if you need something that is missing, please open an issue
 * rather than reaching into `dist/`.
 */

/* -- Profile schema ------------------------------------------------------- */
export {
  profileSchema,
  parseProfile,
  safeParseProfile,
  emptyProfile,
  allBullets,
  findBullet,
  SECTION_KEYS,
  bulletSchema,
  variantSchema,
  workSchema,
  educationSchema,
  projectSchema,
  skillGroupSchema,
  basicsSchema,
  type Profile,
  type Bullet,
  type Variant,
  type VariantSource,
  type Basics,
  type Work,
  type Education,
  type Project,
  type SkillGroup,
  type Certificate,
  type Award,
  type SectionKey,
} from './core/schema';

export { ids, newId } from './core/ids';

/* -- The fabrication guard ------------------------------------------------ */
/**
 * Nothing in the guard is resume-specific. `buildLexicon` accepts any
 * JSON-like source and `checkText` will tell you which proper nouns and numbers
 * in a generated string are not grounded in it — useful for summarisation and
 * RAG output as much as for resumes.
 */
export {
  checkText,
  checkFragments,
  profileLexicon,
  hasBlockingViolations,
  type Violation,
  type GuardReport,
  type Severity,
} from './core/tailor/guard';

export {
  tokenize,
  buildLexicon,
  isGrounded,
  equivalentForms,
  collectStrings,
  type Token,
} from './core/tailor/lexicon';

export {
  SENTENCE_START_ALLOWLIST,
  CALENDAR_WORDS,
  GENERIC_TERMS,
  isCommonSentenceOpener,
} from './core/tailor/stopwords';

/* -- Coverage signals ----------------------------------------------------- */
export {
  extractRequirements,
  buildCoverage,
  type CoverageReport,
  type CoverageTerm,
  type TermStatus,
  type ResumeSlice,
} from './core/tailor/coverage';

/* -- Tailoring ------------------------------------------------------------ */
export {
  tailorPlanSchema,
  TAILOR_PLAN_JSON_SCHEMA,
  identityPlan,
  plannedBulletSchema,
  plannedEntrySchema,
  type TailorPlan,
  type PlannedBullet,
  type PlannedEntry,
} from './core/tailor/plan';

export {
  TAILOR_SYSTEM_PROMPT,
  buildTailorUserPrompt,
  DEFAULT_CONSTRAINTS,
  type TailorConstraints,
} from './core/tailor/prompt';

export {
  buildChanges,
  buildDocument,
  writeBackVariants,
  blockingChanges,
  reviewProgress,
  plannedText,
  type Change,
  type ChangeKind,
  type ChangeStatus,
  type TailorRun,
} from './core/tailor/apply';

export { runTailor, validatePlan, type RunOptions, type TailorOutcome } from './core/tailor/run';

/* -- Job descriptions ----------------------------------------------------- */
export {
  fromPaste,
  htmlToText,
  normalizeText,
  isEmptyJd,
  type JobDescription,
} from './core/jd/normalize';

export {
  detectAts,
  fetchFromAts,
  AtsFetchError,
  type AtsTarget,
  type AtsVendor,
} from './core/jd/ats';

/* -- Providers ------------------------------------------------------------ */
export {
  PROVIDERS,
  PROVIDER_LIST,
  getProvider,
  ProviderError,
  extractJson,
  type LLMProvider,
  type ProviderInfo,
  type ProviderConfig,
  type CompletionRequest,
  type CompletionResult,
  type ModelOption,
} from './core/provider';

/* -- The render model ----------------------------------------------------- */
/**
 * `ResumeDocument` is plain data. It is exported from the main entry — rather
 * than from `sartor/render` — so you can build your own renderer without
 * taking a dependency on ours.
 */
export {
  SECTION_HEADINGS,
  documentToSlices,
  documentToText,
  estimateLines,
  LINES_PER_PAGE,
  type ResumeDocument,
  type DocSection,
  type DocEntry,
  type DocBullet,
  type DocContact,
  type DocSkillGroup,
} from './core/render/model';

export {
  parseSafetyChecks,
  worstStatus,
  type ParseCheck,
  type CheckStatus,
} from './core/render/parseSafety';

export {
  TEMPLATES,
  getTemplate,
  isBuiltInTemplate,
  templateSchema,
  type Template,
  type TemplateRef,
} from './core/render/templates';

/**
 * Plain text is rendered from the main entry, not from `sartor/render/*`.
 * The PDF and DOCX renderers live behind their own subpaths because each pulls
 * in a heavy engine; this one is a string builder with no dependencies, so
 * making it a separate import would cost more than it saves.
 */
export { renderPlainText, renderTextBlob } from './core/render/text';

/**
 * The gap interview: what to ask, how to ask it, and how to read the answer.
 *
 * `findGaps` is deterministic and needs no model — question *selection* is
 * measured, not improvised. The prompts are the only part a provider sees.
 */
export {
  findGaps,
  remainingGaps,
  type Gap,
  type GapKind,
  type FindGapsOptions,
} from './core/interview/gaps';

export {
  INTERVIEW_SYSTEM_PROMPT,
  buildQuestionsPrompt,
  buildAnswerPrompt,
  questionsSchema,
  draftedBulletsSchema,
  QUESTIONS_JSON_SCHEMA,
  DRAFTED_BULLETS_JSON_SCHEMA,
  type InterviewQuestion,
  type DraftedBullet,
} from './core/interview/ask';

/**
 * The conversation layer over the interview: what a reply may turn into, and
 * which taps resolve with no model call at all.
 */
export {
  quickReplies,
  applyQuickReply,
  bestOwner,
  currentQuestion,
  followUpQuestion,
  lanesFor,
  progress,
  type LaneKind,
  type QuickReply,
  type ImmediateResult,
  type OwnerGuess,
  type Progress,
} from './core/interview/conversation';

/**
 * Checking a drafted bullet against the answer that produced it, which is what
 * lets the interview rewrite for strength without letting it invent.
 */
export {
  verifyDraft,
  needsFollowUp,
  answerLexicon,
  type VerifiedBullet,
  type VerifiedDraft,
} from './core/interview/verify';
