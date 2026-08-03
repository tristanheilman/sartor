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
 *
 * ⚠️ Never add a word that is also a technology name. `go` belongs here as an
 * ordinary verb and was briefly added, which silently stopped Go from being
 * recognised as a skill. The asymmetry decides it: a lowercase verb is never a
 * candidate in the first place (candidates must be capitalised), so listing one
 * of these buys nothing and costs a real detection. The same trap is waiting in
 * `rust`, `swift`, `dart`, `ruby`, `julia`, `crystal`, `elm`, and `nim`.
 *
 * The list is in three blocks: function words and past-tense verbs; present and
 * third-person verb forms, which a summary written in the third person opens
 * lines with; and adjectives and adverbs.
 *
 * That last block was missing entirely until a generated summary opened with
 * "Additional experience with Firebase" and the guard flagged "Additional" as a
 * possible fabricated product name — blocking export over an ordinary English
 * adjective. Sweeping eleven generated documents turned up that one false
 * positive and no others, so the fix was this narrow.
 *
 * Nothing added is a technology name. Note the deliberate absence of `swift`,
 * which is both an ordinary adjective and a language, and which the warning
 * above forbids.
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

apply bring come demonstrate enjoy expect explore fit gain get give handle hire join keep know look love make
meet need offer prefer seek share start stay take thrive use want welcome
applying bringing expecting exploring hiring joining looking making meeting needing offering seeking sharing
starting taking using wanting
comes expects gets gives goes handles helps includes keeps knows looks makes means meets needs offers prefers
requires seeks takes uses wants works

builds delivers designs develops drives ensures enjoys grows guides implements improves integrates leads
maintains manages mentors operates optimizes owns partners performs plans prepares presents prioritizes provides
reports researches reviews scales ships solves supports tests understands writes

additional additionally broad closely comfortable complex consistent consistently continuous continuously
current currently daily deep deeply demonstrated direct directly effective effectively efficient efficiently
experienced extensive extensively familiar frequent frequently fully heavily highly independently initial
initially junior multiple numerous ongoing overall previous previously primary primarily proficient proven
rapidly recent recently regular regularly reliable responsible senior significantly skilled solid strong
subsequently substantial successful successfully technical ultimately various weekly wide widely
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
