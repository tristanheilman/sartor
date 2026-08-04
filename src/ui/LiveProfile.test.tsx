// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { LiveProfile } from './App';
import { profileSchema, type Profile } from '../core/schema';

/**
 * The panel beside the conversation, which is the only feedback an answer gets.
 *
 * Its own reason for existing is that "answering a question and seeing nothing
 * change is the fastest way to stop trusting a tool" — and it did exactly that
 * for projects, because it walked `profile.work` and nothing else. Someone
 * could answer four questions about published packages, watch every one land
 * in storage, and see an unchanged panel reporting the same bullet count.
 *
 * Projects are the half of the profile most likely to be edited during an
 * interview, since they are what the gap finder asks about most.
 */

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: 'now',
  updatedAt: 'now',
  basics: { name: 'Priya Raman' },
  work: [
    {
      id: 'wrk_1',
      name: 'Halcyon Fleet',
      position: 'Lead Mobile Developer',
      startDate: '05/2022',
      bullets: [{ id: 'b1', text: 'Owned the release process.' }],
    },
  ],
  projects: [
    {
      id: 'prj_1',
      name: 'react-native-island',
      bullets: [
        { id: 'p1', text: 'Exposes iOS Live Activities to React Native apps.' },
        { id: 'p2', text: 'Bridges Android notifications through the same API.' },
      ],
    },
    { id: 'prj_2', name: 'diy-swing-analysis', bullets: [] },
  ],
  skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Swift', 'TypeScript'] }],
});

afterEach(cleanup);

describe('the live profile panel', () => {
  it('shows the roles and their bullets', () => {
    render(<LiveProfile profile={profile} />);

    expect(screen.getByText('Lead Mobile Developer')).toBeDefined();
    expect(screen.getByText(/Owned the release process/)).toBeDefined();
  });

  it('shows each project by name', () => {
    render(<LiveProfile profile={profile} />);

    expect(screen.getByText('react-native-island')).toBeDefined();
    expect(screen.getByText('diy-swing-analysis')).toBeDefined();
  });

  it('shows the lines written under a project', () => {
    // The specific failure: an answer about a package produced bullets, the
    // merge stored them, and the panel rendered none of it.
    render(<LiveProfile profile={profile} />);

    expect(screen.getByText(/Exposes iOS Live Activities/)).toBeDefined();
    expect(screen.getByText(/Bridges Android notifications/)).toBeDefined();
  });

  it('counts project bullets in the total, so answering one moves the number', () => {
    // 1 under the role plus 2 under react-native-island. Counting work alone
    // reported 1, and the count is the one thing on the panel a person watches
    // to know whether their answer did anything.
    render(<LiveProfile profile={profile} />);

    expect(screen.getByText(/3 bullets/)).toBeDefined();
  });

  it('says how many projects there are alongside the roles', () => {
    render(<LiveProfile profile={profile} />);
    expect(screen.getByText(/2 projects/)).toBeDefined();
  });

  it('renders a profile with no projects at all', () => {
    // Not everyone has any, and the header must not read "0 projects" as
    // though something were missing.
    const bare = profileSchema.parse({ ...profile, projects: [] });
    render(<LiveProfile profile={bare} />);

    expect(screen.getByText(/1 bullet/)).toBeDefined();
    expect(screen.queryByText(/projects/)).toBeNull();
  });
});
