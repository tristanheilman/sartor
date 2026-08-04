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
    section: { marginBottom: t.sectionGap },
    heading: {
      fontFamily: t.headingFont,
      fontSize: t.baseSize * 1.05,
      letterSpacing: t.uppercaseHeadings ? 0.8 : 0,
      marginBottom: 4,
      paddingBottom: t.headingRule ? 2 : 0,
      borderBottomWidth: t.headingRule ? 0.75 : 0,
      borderBottomColor: '#999999',
    },
    entry: { marginBottom: t.entryGap },
    entryTopRow: { flexDirection: 'row', justifyContent: 'space-between' },
    entryPrimary: { fontFamily: t.headingFont, fontSize: t.baseSize * 1.02 },
    entryMeta: { fontSize: t.baseSize * 0.95, color: '#444444' },
    entrySecondRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
    entrySecondary: { fontSize: t.baseSize },
    entrySummary: { marginBottom: 2 },
    bulletRow: { flexDirection: 'row', marginBottom: t.bulletGap, paddingRight: 4 },
    bulletGlyph: { width: 10 },
    bulletText: { flex: 1 },
    skillRow: { marginBottom: 2 },
    skillName: { fontFamily: t.headingFont },
    listItem: { marginBottom: 2 },
  });
}

/**
 * Points of room a section heading needs beneath it before it will sit on a
 * page — about the two lines of an entry header.
 *
 * Was 48, and applied to the entry header as well, which compounded: the
 * heading demanded 48pt, then the header inside it demanded another 48. An
 * education entry has no bullets, so that space could never exist and the whole
 * section moved to a page of its own — eighty characters alone on page two,
 * while a quarter of page one sat empty.
 */
const MIN_ROOM_AFTER_HEADING = 30;

/**
 * Room an entry header needs before it will sit on a page.
 *
 * One line: enough that a job title is not the last thing on a page with its
 * first bullet overleaf. Only asked for when there is a bullet to follow —
 * demanding space after an entry that has nothing after it is how education
 * ended up on its own page.
 */
const MIN_ROOM_AFTER_ENTRY_HEADER = 18;

type Styles = ReturnType<typeof makeStyles>;

function SectionBody({ section, s }: { section: DocSection; s: Styles }) {
  if (section.kind === 'summary') return <Text>{section.summary}</Text>;

  if (section.kind === 'skills') {
    return (
      <>
        {section.skills?.map((g) => (
          // One paragraph, not two columns. As a flex row the keywords formed
          // their own column, so every wrapped line hung at wherever that
          // column happened to start — a different indent for each group,
          // because the labels are different lengths. "Mobile & Web
          // Development" pushed its continuation a third of the way across the
          // page while "Tools & DevOps" barely moved, and the section read as
          // ragged and half-centred.
          //
          // Nested Text keeps the label bold and lets the whole thing wrap back
          // to the left margin like the prose it is. It also puts the group and
          // its keywords in one text run, which is friendlier to extraction
          // than two adjacent boxes.
          <Text key={g.sourceId} style={s.skillRow}>
            <Text style={s.skillName}>{g.name}: </Text>
            {g.keywords.join(', ')}
          </Text>
        ))}
      </>
    );
  }

  if (section.kind === 'list') {
    return (
      <>
        {section.items?.map((i) => (
          <Text key={i.sourceId} style={s.listItem}>
            {i.text}
          </Text>
        ))}
      </>
    );
  }

  return (
    <>
      {section.entries?.map((e) => (
        // Not `wrap={false}`. A role with fifteen bullets cannot fit in a
        // part-used page, so refusing to split moved the entire entry to the
        // next one — stranding the section heading above a third of a page of
        // white space. Entries may break; the header rows below may not.
        <View key={e.sourceId} style={s.entry}>
          {/* Job title, employer and dates stay together, and take a bullet
              with them — a role heading alone at the foot of a page reads as
              though the job had nothing in it. */}
          <View
            wrap={false}
            minPresenceAhead={e.bullets.length ? MIN_ROOM_AFTER_ENTRY_HEADER : 0}
          >
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
          </View>
          {e.summary ? <Text style={s.entrySummary}>{e.summary}</Text> : null}
          {e.bullets.map((b) => (
            <View key={b.sourceId} style={s.bulletRow}>
              <Text style={s.bulletGlyph}>•</Text>
              <Text style={s.bulletText}>{b.text}</Text>
            </View>
          ))}
        </View>
      ))}
    </>
  );
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
        <View>
          <Text style={s.name}>{doc.contact.name}</Text>
          {doc.contact.label ? <Text style={s.label}>{doc.contact.label}</Text> : null}
          {doc.contact.details.length > 0 ? (
            <Text style={s.contact}>{doc.contact.details.join(CONTACT_SEPARATOR)}</Text>
          ) : null}
        </View>

        {doc.sections.map((section) => (
          <View key={section.key} style={s.section}>
            {/* A heading with nothing under it is worse than a heading on the
                next page, so require room for something to follow it. */}
            <Text style={s.heading} minPresenceAhead={MIN_ROOM_AFTER_HEADING}>
              {t.uppercaseHeadings ? section.heading.toUpperCase() : section.heading}
            </Text>
            <SectionBody section={section} s={s} />
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderPdfBlob(doc: ResumeDocument, templateId: TemplateRef): Promise<Blob> {
  return pdf(<ResumePdf doc={doc} templateId={templateId} />).toBlob();
}
