import { ids } from '../ids';
import type { Bullet, Profile } from '../schema';

/**
 * Two bullets in one entry that a reading of the resume took to be the same
 * fact said twice.
 *
 * A suggestion, never a decision: it comes from the model, which is the only
 * thing that can tell — word overlap scores real pairs below unrelated ones —
 * and the person settles it with `keepOneWording` or by ignoring it.
 */
export interface DuplicateBullets {
  entryId: string;
  /** The role or project, so the person can find the pair on the page. */
  entryName: string;
  /** In the order they appear in the entry. */
  bulletIds: [string, string];
}

/**
 * Settles a pair: `keepId` stays the bullet, and `otherId` becomes one of its
 * variants, word for word, along with any variants it already had.
 *
 * This is what variants are for — alternate wordings of one fact — and it is
 * what `planMerge` already does with a reworded bullet arriving from a second
 * resume. Nothing is rewritten and nothing is lost: both wordings stay in the
 * profile, tailoring can still choose either, and only one of them can be
 * picked as a separate line.
 *
 * Returns the profile unchanged when the two are not in the same entry, since
 * a bullet can only be a variant of a fact from the same job.
 */
export function keepOneWording(profile: Profile, keepId: string, otherId: string): Profile {
  for (const section of ['work', 'projects', 'education'] as const) {
    const index = profile[section].findIndex(
      (e) => e.bullets.some((b) => b.id === keepId) && e.bullets.some((b) => b.id === otherId),
    );
    if (index === -1 || keepId === otherId) continue;

    const next = structuredClone(profile);
    const entry = next[section][index]!;
    const keep = entry.bullets.find((b) => b.id === keepId)!;
    const other = entry.bullets.find((b) => b.id === otherId)!;

    keep.variants.push(...asVariants(other, keep));
    entry.bullets = entry.bullets.filter((b) => b.id !== otherId);
    return next;
  }
  return profile;
}

/** `other`'s wording and its own variants, minus any `keep` already holds. */
function asVariants(other: Bullet, keep: Bullet): Bullet['variants'] {
  const held = new Set([keep.text, ...keep.variants.map((v) => v.text)].map((t) => t.trim()));
  const incoming = [
    {
      id: ids.variant(),
      text: other.text,
      // The person wrote it, in their own resume; it is not model output.
      source: 'original' as const,
      createdAt: new Date().toISOString(),
      note: 'Imported as a separate bullet',
    },
    ...other.variants,
  ];
  return incoming.filter((v) => {
    const t = v.text.trim();
    if (!t || held.has(t)) return false;
    held.add(t);
    return true;
  });
}
