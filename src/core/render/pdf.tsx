import type { ReactNode } from 'react';
import { Document, Font, Page, Text, View, StyleSheet, pdf } from '@react-pdf/renderer';
import type { ResumeDocument, DocSection } from './model';
import { getTemplate, type Template, type TemplateRef } from './templates';

/**
 * PDF rendering.
 *
 * Structurally this is a stack of `View`s containing `Text`. No tables, no
 * absolute positioning, no `fixed` header or footer, no images. Text flows in a
 * single column in reading order, which is exactly what a text extractor walks.
 */

/**
 * Never break a word across lines.
 *
 * @react-pdf hyphenates by default, and a hyphen inserted at a line break ends
 * up in the text layer: "significant-location-change" came back out of a
 * rendered PDF as "significant-loca- tion-change". That silently breaks the one
 * property this whole export path exists to guarantee — that the document says
 * the same thing to a parser as it does to a person — and it breaks keyword
 * matching for the reader on the other end, who is searching for a whole word.
 *
 * Returning the word as a single fragment is how @react-pdf is told not to
 * split it. The cost is that a word longer than the column can overflow rather
 * than break; on a resume, the longest tokens are identifiers and URLs, and a
 * URL that runs to the margin is a smaller problem than one that cannot be
 * copied.
 *
 * Registered at module load, because it is global to the renderer and there is
 * no document for which we would want the other behaviour.
 */
Font.registerHyphenationCallback((word) => [word]);

/**
 * Separator between contact details.
 *
 * One space each side, not two. With two, a line that wraps at the separator
 * gets a hyphen written into the text layer — the contact line came back out of
 * a rendered PDF ending "linkedin.com/in/tristanheilman ·-", with the hyphen
 * both drawn on the page and present in the extracted text. The callback above
 * stops words being split; it does not stop this, because the thing being
 * broken is the separator rather than a word.
 *
 * The bug only shows once the contact line is long enough to wrap, which is why
 * it went unnoticed until profile links started being captured.
 */
const CONTACT_SEPARATOR = ' · ';

function makeStyles(t: Template) {
  return StyleSheet.create({
    page: {
      paddingTop: t.pageMargin,
      paddingBottom: t.pageMargin,
      paddingHorizontal: t.pageMargin,
      fontFamily: t.bodyFont,
      fontSize: t.baseSize,
      lineHeight: t.lineHeight,
      color: '#111111',
    },
    // The page sets `lineHeight` for body text, and at nearly twice the body
    // size the name inherits a line box too tight for its own descenders — the
    // headline underneath sat hard against it. Both get their own leading and
    // a real gap, so the three header lines read as a block rather than as one
    // collided line and two loose ones.
    name: {
      fontFamily: t.headingFont,
      fontSize: t.baseSize * 1.9,
      lineHeight: 1.2,
      marginBottom: 4,
    },
    label: { fontSize: t.baseSize * 1.05, lineHeight: 1.3, color: '#333333', marginBottom: 4 },
    // Contact details render as ordinary body text, inline, at the top of the
    // page — deliberately not in a PDF header, which extractors often skip.
    contact: { fontSize: t.baseSize * 0.95, color: '#333333', marginBottom: t.sectionGap },
    heading: {
      fontFamily: t.headingFont,
      fontSize: t.baseSize * 1.05,
      letterSpacing: t.uppercaseHeadings ? 0.8 : 0,
      marginBottom: 4,
      paddingBottom: t.headingRule ? 2 : 0,
      borderBottomWidth: t.headingRule ? 0.75 : 0,
      borderBottomColor: '#999999',
    },
    entryTopRow: { flexDirection: 'row', justifyContent: 'space-between' },
    entryPrimary: { fontFamily: t.headingFont, fontSize: t.baseSize * 1.02 },
    entryMeta: { fontSize: t.baseSize * 0.95, color: '#444444' },
    entrySecondRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
    entrySecondary: { fontSize: t.baseSize },
    entrySummary: { marginBottom: 2 },
    bulletRow: { flexDirection: 'row', marginBottom: t.bulletGap, paddingRight: 4 },
    bulletGlyph: { width: 10 },
    bulletText: { flex: 1 },
    headerCentered: { textAlign: 'center' },
    skillRow: { marginBottom: 2 },
    skillName: { fontFamily: t.headingFont },
    // Enough contrast to separate groups without reading as punctuation
    // inside a list that already uses commas.
    skillSeparator: { color: '#777777' },
    listItem: { marginBottom: 2 },
  });
}

/** Between skill groups when they run together on one line. */
const SKILL_SEPARATOR = '   ·   ';

type Styles = ReturnType<typeof makeStyles>;

/**
 * Where a page may break, and where it may not.
 *
 * The page is a flat run of blocks, each of which @react-pdf may move to the
 * next page but never split:
 *
 *   - a section heading, with whatever follows it — the summary, the skills,
 *     the first list item, or the first entry's title and first bullet;
 *   - an entry's title rows, with its first bullet;
 *   - every other bullet, marker and text together.
 *
 * It was a section containing entries containing bullets, with `minPresence
 * Ahead` to keep headings off the foot of a page. Three things went wrong with
 * that, all of them @react-pdf's behaviour rather than ours:
 *
 *   - A bullet's marker and its text were split independently. The one-line
 *     marker fitted, the text was moved whole by @react-pdf's orphan rule, and
 *     a page ended on "•" with the bullet's words overleaf.
 *   - `minPresenceAhead` is only honoured on an element with an earlier
 *     sibling in its own container, and a heading is always the first child
 *     of its section. Neither guard ever ran, and a role's title sat at the
 *     foot of a page with every bullet under it on the next.
 *   - An element whose content fits but whose bottom margin does not is moved
 *     whole. A role with eleven bullets went to page two over less than a
 *     point of margin, leaving half of page one empty and a two-page target
 *     at three pages.
 *
 * Blocks make the first two impossible by construction, and shrink the third
 * to one block — a bullet or a title, never a whole role or section.
 *
 * The spacing is unchanged. An entry's and a section's bottom margins move
 * onto their last block, where they sum exactly as they did before, so nothing
 * here alters the look of a page that does not break — and `estimateHeight`
 * measures the same document it did.
 */
function sectionBlocks(section: DocSection, s: Styles, t: Template) {
  const heading = (
    <Text style={s.heading}>{t.uppercaseHeadings ? section.heading.toUpperCase() : section.heading}</Text>
  );

  // Each block, and how much space it leaves below itself.
  const blocks: Array<{ key: string; gap: number; body: ReactNode }> = [];

  if (section.kind === 'summary') {
    blocks.push({ key: 'summary', gap: 0, body: <>{heading}<Text>{section.summary}</Text></> });
  } else if (section.kind === 'skills') {
    const groups = section.skills ?? [];
    blocks.push({
      key: 'skills',
      gap: 0,
      body: (
        <>
          {heading}
          {/* One flowing paragraph, not a line per group.

              A group per line wastes whatever is left of the last line of
              each. On a real resume "Languages & Frameworks" wrapped so that
              "NodeJS, CSS" sat alone on a line, and "Tools & DevOps" ended a
              third of the way across — two thirds of two lines, gone. Worse,
              the trim was dropping whole groups to buy back space the layout
              was wasting, so a posting asking for Docker, GCP, Jest, Detox
              and Appium got a resume that had cut the sections naming them.

              Flowed, the text fills every line it starts, and the labels stay
              bold so the section is still scannable rather than a wall of
              nouns. */}
          <Text style={s.skillRow}>
            {groups.map((g, i) => (
              <Text key={g.sourceId}>
                {i > 0 ? <Text style={s.skillSeparator}>{SKILL_SEPARATOR}</Text> : null}
                <Text style={s.skillName}>{g.name}: </Text>
                {g.keywords.join(', ')}
              </Text>
            ))}
          </Text>
        </>
      ),
    });
  } else if (section.kind === 'list') {
    const items = section.items ?? [];
    if (!items.length) blocks.push({ key: 'heading', gap: 0, body: heading });
    items.forEach((i, n) =>
      blocks.push({
        key: i.sourceId,
        gap: 0,
        body: (
          <>
            {n === 0 ? heading : null}
            <Text style={s.listItem}>{i.text}</Text>
          </>
        ),
      }),
    );
  } else {
    const entries = section.entries ?? [];
    if (!entries.length) blocks.push({ key: 'heading', gap: 0, body: heading });
    entries.forEach((e, n) => {
      const bullet = (b: (typeof e.bullets)[number]) => (
        <View style={s.bulletRow}>
          <Text style={s.bulletGlyph}>•</Text>
          <Text style={s.bulletText}>{b.text}</Text>
        </View>
      );
      const [first, ...rest] = e.bullets;

      // Title, employer and dates, with the first bullet: a role heading
      // alone at the foot of a page reads as though the job had nothing in it.
      blocks.push({
        key: e.sourceId,
        gap: 0,
        body: (
          <>
            {n === 0 ? heading : null}
            <View style={s.entryTopRow}>
              <Text style={s.entryPrimary}>{e.primary}</Text>
              {e.meta ? <Text style={s.entryMeta}>{e.meta}</Text> : null}
            </View>
            {e.secondary || e.aside ? (
              <View style={s.entrySecondRow}>
                <Text style={s.entrySecondary}>{e.secondary}</Text>
                {e.aside ? <Text style={s.entryMeta}>{e.aside}</Text> : null}
              </View>
            ) : null}
            {e.summary ? <Text style={s.entrySummary}>{e.summary}</Text> : null}
            {first ? bullet(first) : null}
          </>
        ),
      });
      for (const b of rest) blocks.push({ key: b.sourceId, gap: 0, body: bullet(b) });
      blocks[blocks.length - 1]!.gap += t.entryGap;
    });
  }

  blocks[blocks.length - 1]!.gap += t.sectionGap;

  return blocks.map((b) => (
    <View key={`${section.key}:${b.key}`} wrap={false} style={b.gap ? { marginBottom: b.gap } : undefined}>
      {b.body}
    </View>
  ));
}

export function ResumePdf({ doc, templateId }: { doc: ResumeDocument; templateId: TemplateRef }) {
  const t = getTemplate(templateId);
  const s = makeStyles(t);

  return (
    <Document
      title={`${doc.contact.name} — Resume`}
      author={doc.contact.name}
      creator="Sartor"
      producer="Sartor"
    >
      <Page size="LETTER" style={s.page}>
        <View style={t.centerHeader ? s.headerCentered : undefined}>
          <Text style={s.name}>{doc.contact.name}</Text>
          {doc.contact.label ? <Text style={s.label}>{doc.contact.label}</Text> : null}
          {doc.contact.details.length > 0 ? (
            <Text style={s.contact}>{doc.contact.details.join(CONTACT_SEPARATOR)}</Text>
          ) : null}
        </View>

        {doc.sections.flatMap((section) => sectionBlocks(section, s, t))}
      </Page>
    </Document>
  );
}

export async function renderPdfBlob(doc: ResumeDocument, templateId: TemplateRef): Promise<Blob> {
  return pdf(<ResumePdf doc={doc} templateId={templateId} />).toBlob();
}
