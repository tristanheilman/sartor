// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { profileSchema, type Profile } from '../../index';
import { ProfileEditor } from './ProfileEditor';

/**
 * The confirmation form, showing an import's suspected repeats.
 *
 * The person settles each pair here, before the profile is saved. Settling it
 * must keep both wordings — one as the bullet, one as its variant — because
 * "nothing is rewritten" is a promise about the person's own text.
 */

afterEach(cleanup);

const MISSPELLED =
  'Built a public React Native library to bridge iOS ObjectCapture and PhotogrammatrySession views and classes to the javascript scope';
const BETTER =
  "Published a React Native library bridging Apple's Object Capture and PhotogrammetrySession into JavaScript, enabling LiDAR scanning of real objects.";

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: 'now',
  updatedAt: 'now',
  basics: { name: 'Dana Reyes' },
  projects: [
    {
      id: 'prj_capture',
      name: 'react-native-object-capture',
      bullets: [
        { id: 'blt_a', text: MISSPELLED },
        { id: 'blt_b', text: 'Published and maintaining a public NPM package' },
        { id: 'blt_c', text: BETTER },
      ],
    },
  ],
});

const pair = { entryId: 'prj_capture', entryName: 'react-native-object-capture', bulletIds: ['blt_a', 'blt_c'] as [string, string] };

describe('a suspected repeat from the import', () => {
  it('shows both wordings side by side', () => {
    render(<ProfileEditor profile={profile} onChange={() => {}} duplicates={[pair]} />);
    expect(screen.getByText(/the same fact said twice/i)).toBeDefined();
    expect(screen.getAllByRole('button', { name: /keep this wording/i })).toHaveLength(2);
  });

  it('keeps the chosen wording as the bullet and the other as its variant', () => {
    const onChange = vi.fn();
    render(<ProfileEditor profile={profile} onChange={onChange} duplicates={[pair]} />);

    fireEvent.click(screen.getAllByRole('button', { name: /keep this wording/i })[1]!);
    const next: Profile = onChange.mock.calls[0]![0];
    const bullets = next.projects[0]!.bullets;

    expect(bullets.map((b) => b.text)).toEqual(['Published and maintaining a public NPM package', BETTER]);
    expect(bullets[1]!.variants.map((v) => v.text)).toEqual([MISSPELLED]);
  });

  it('leaves both alone when told they are different', () => {
    const onChange = vi.fn();
    render(<ProfileEditor profile={profile} onChange={onChange} duplicates={[pair]} />);

    fireEvent.click(screen.getByRole('button', { name: /they're different/i }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText(/the same fact said twice/i)).toBeNull();
  });

  it('stops asking once one of the pair is gone', () => {
    const merged = profileSchema.parse({
      ...profile,
      projects: [{ ...profile.projects[0]!, bullets: profile.projects[0]!.bullets.filter((b) => b.id !== 'blt_a') }],
    });
    render(<ProfileEditor profile={merged} onChange={() => {}} duplicates={[pair]} />);
    expect(screen.queryByText(/the same fact said twice/i)).toBeNull();
  });
});
