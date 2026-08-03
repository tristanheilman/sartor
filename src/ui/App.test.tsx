// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { App } from './App';

/**
 * Smoke tests for the shell.
 *
 * These exist to catch the "app renders a blank page" class of failure that
 * compiles perfectly and only shows up at runtime — and to pin down two claims
 * the README makes: that the key never leaves sessionStorage, and that the app
 * is usable enough to reach the import step without one.
 */

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(cleanup);

/**
 * Mounts the app and opens the settings popover.
 *
 * Provider and key moved behind a button: they are touched once a session, and
 * a panel about API keys was the first thing anyone saw. Everything these tests
 * assert about the key still holds — it just has to be opened first.
 */
async function openSettings() {
  render(<App />);
  await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: /settings/i }));
  await waitFor(() => expect(screen.getByLabelText(/^provider$/i)).toBeDefined());
}

describe('App', () => {
  it('mounts and reaches a usable first screen', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    // The resume is the first thing on screen, not a form about API keys.
    expect(screen.getByRole('heading', { name: /start with your resume/i })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /model provider/i })).toBeNull();
  });

  it('keeps the provider settings one click away', async () => {
    await openSettings();
    expect(screen.getByRole('heading', { name: /model provider/i })).toBeDefined();
  });

  it('says whether a key is loaded without opening anything', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    // Hiding the panel must not hide its state.
    expect(screen.getByRole('button', { name: /settings — no key yet/i })).toBeDefined();
  });

  it('offers all three providers', async () => {
    await openSettings();
    const select = screen.getByLabelText(/^provider$/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(['anthropic', 'openai', 'google']);
  });

  it('defaults Anthropic to Claude Opus 5', async () => {
    await openSettings();
    expect((screen.getByLabelText(/^model$/i) as HTMLSelectElement).value).toBe('claude-opus-5');
  });

  it('stores an entered key in sessionStorage and nowhere else', async () => {
    await openSettings();

    const input = screen.getByLabelText(/anthropic api key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-test-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));

    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());
    expect(sessionStorage.getItem('sartor.key.anthropic')).toBe('sk-ant-test-key-1234567890');
    expect(localStorage.getItem('sartor.key.anthropic')).toBeNull();
    expect(document.cookie).not.toContain('sk-ant');
  });

  it('never renders the key in full unless it is asked for', async () => {
    await openSettings();

    const key = 'sk-ant-supersecretvalue-abcdefg';
    fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));

    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());
    expect(document.body.textContent).not.toContain(key);
    expect(document.body.textContent).toContain('•');
  });

  it('shows the key only when deliberately revealed, and hides it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openSettings();

      const key = 'sk-ant-supersecretvalue-abcdefg';
      fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: key } });
      fireEvent.click(screen.getByRole('button', { name: /use key/i }));
      await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());

      fireEvent.click(screen.getByRole('button', { name: /show key/i }));
      expect(document.body.textContent).toContain(key);

      // The reason it is masked by default — screenshots, shoulders — is just
      // as true ten seconds later, so it puts itself away.
      await act(async () => {
        vi.advanceTimersByTime(11_000);
      });
      await waitFor(() => expect(document.body.textContent).not.toContain(key));
    } finally {
      vi.useRealTimers();
    }
  });

  it('can hand the key back without ever showing it', async () => {
    const written: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
    });

    await openSettings();
    const key = 'sk-ant-supersecretvalue-abcdefg';
    fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));
    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /copy key/i }));
    await waitFor(() => expect(written).toEqual([key]));
    // Copying is the point; rendering it is not required to do that.
    expect(document.body.textContent).not.toContain(key);
  });

  it('forgets the key on request', async () => {
    await openSettings();

    fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: 'sk-ant-x1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));
    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /forget key/i }));
    await waitFor(() => expect(sessionStorage.getItem('sartor.key.anthropic')).toBeNull());
  });

  it('lets someone build a profile by hand without an API key', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /build one from scratch/i }));
    await waitFor(() => expect(screen.getByText(/confirm before saving/i)).toBeDefined());
    expect(screen.getByRole('button', { name: /save profile and continue/i })).toBeDefined();
    // The editable form is there, so nothing has been guessed on the user's behalf.
    expect(screen.getByLabelText(/full name/i)).toBeDefined();
  });

  it('shows no step navigation until there is somewhere to go', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    // With no profile, every later step is unreachable, so the row is noise.
    expect(screen.queryByRole('button', { name: /^review$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^export$/i })).toBeNull();
  });

  it('never strands the user on a step that has just become unavailable', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    // Build and save a profile, which unlocks step 2 and navigates there.
    fireEvent.click(screen.getByRole('button', { name: /build one from scratch/i }));
    await waitFor(() => expect(screen.getByLabelText(/full name/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Dana Reyes' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile and continue/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /the job posting/i })).toBeDefined());

    // The step row appears with the profile, and only what is reachable is
    // enabled: Review needs a run, Export needs only a profile.
    expect(screen.getByRole('button', { name: /^review$/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /^export$/i })).toHaveProperty('disabled', false);

    // Erase everything from under it. The nav disables step 2, so the app must
    // not keep rendering step 2's content.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /erase all local data/i }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /start with your resume/i })).toBeDefined(),
    );
    expect(screen.queryByRole('heading', { name: /the job posting/i })).toBeNull();
    // With the profile gone there is nowhere to navigate to, so the whole row
    // goes with it rather than sitting there fully disabled.
    expect(screen.queryByRole('button', { name: /job posting/i })).toBeNull();
  });

  it('states where the key goes, at the point of entry', async () => {
    await openSettings();
    const text = document.body.textContent ?? '';
    expect(text).toContain('sessionStorage');
    expect(text).toContain('anthropic-dangerous-direct-browser-access');
  });
});
