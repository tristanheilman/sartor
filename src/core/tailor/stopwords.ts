/**
 * Words that may legitimately appear capitalised at the start of a sentence
 * without being a proper noun.
 *
 * This list exists to keep the fabrication guard usable. The model is *allowed*
 * to rephrase, so a bullet that read "Led the migration" may come back as
 * "Directed the migration". At the start of a sentence there is no
 * morphological difference between "Directed" (fine) and "Datadog" (a fabricated
 * employer), so without this list every rephrased opener would be flagged and
 * the guard would be ignored as noise.
 *
 * Mid-sentence capitals, all-caps tokens, internal capitals, and anything
 * containing a digit are never exempted by this list — those are checked
 * strictly regardless of position.
 */

const WORDS = `
a about above across after again against all almost along already also although always am among an and another any
anyone are around as at automated back be became because been before began behind being below beside best better
between beyond both brought build building built but by came can cannot certain clear closely co collaborated
consolidated coordinated could created cut daily decreased defined delivered deployed described designed developed
did directed do documented does doing done down drove drafted during each earlier early eight either eliminated
enabled ended engineered enhanced ensured established evaluated even every executed expanded facilitated few
finally first five followed for former found founded four from further gave generated given got greater grew
guided had halved has have having headed held helped her here high his how identified if implemented improved in
included increased influenced information initiated instead integrated into introduced investigated is it its just
kept key launched led less like likely made maintained major managed many mapped may mentored merged met might
migrated modernized more most moved much must my near nearly negotiated never new next nine no not now of off often
on once one only onto operated optimized or orchestrated other our out over overhauled owned partnered performed
piloted placed planned prepared presented prevented prior produced programmed promoted proposed provided published
put ran rebuilt received recommended reduced refactored released removed reorganized replaced reported researched
resolved restructured returned reviewed revised rewrote ran saved scaled scoped secured selected served set seven
several shaped shipped should showed significant simplified since six slashed so solved some sourced spearheaded
specified sped standardized started streamlined strengthened structured such supervised supported sustained
taught team ten tested than that the their them then there these they this those three through throughout thus to
together took tracked trained transformed translated tripled turned two under unified until up updated upgraded
used using validated very via was we were what when where whether which while who why will with within without
worked would wrote yet

build collaborate communicate contribute coordinate create define deliver design develop drive ensure establish
evaluate execute experience grow guide identify implement improve integrate iterate join lead learn maintain
manage mentor operate optimize own partner perform plan prepare present prioritize provide report research
review scale ship solve support test troubleshoot understand write
`
  .trim()
  .split(/\s+/);

export const SENTENCE_START_ALLOWLIST = new Set(WORDS);

/** Months and weekday names — common in date phrasings, never fabrications. */
export const CALENDAR_WORDS = new Set(
  `january february march april may june july august september october november december
   jan feb mar apr jun jul aug sep sept oct nov dec
   monday tuesday wednesday thursday friday saturday sunday
   present current ongoing today`
    .trim()
    .split(/\s+/),
);

/**
 * Terms so generic that flagging them produces noise without protecting
 * anyone. These are *not* employers, technologies, or metrics.
 */
export const GENERIC_TERMS = new Set(
  `i my me resume cv summary experience education skills projects certifications awards
   present company team teams role position title responsibilities responsible
   inc llc ltd corp co gmbh plc sa bv`
    .trim()
    .split(/\s+/),
);

export function isCommonSentenceOpener(norm: string): boolean {
  return (
    SENTENCE_START_ALLOWLIST.has(norm) ||
    CALENDAR_WORDS.has(norm) ||
    GENERIC_TERMS.has(norm)
  );
}
