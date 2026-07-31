// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
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

describe('App', () => {
  it('mounts and reaches a usable first screen', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    expect(screen.getByRole('heading', { name: /model provider/i })).toBeDefined();
    expect(screen.getByRole('heading', { name: /start from an existing resume/i })).toBeDefined();
  });

  it('offers all three providers', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    const select = screen.getByLabelText(/^provider$/i) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(['anthropic', 'openai', 'google']);
  });

  it('defaults Anthropic to Claude Opus 5', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    expect((screen.getByLabelText(/^model$/i) as HTMLSelectElement).value).toBe('claude-opus-5');
  });

  it('stores an entered key in sessionStorage and nowhere else', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    const input = screen.getByLabelText(/anthropic api key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-test-key-1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));

    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());
    expect(sessionStorage.getItem('sartor.key.anthropic')).toBe('sk-ant-test-key-1234567890');
    expect(localStorage.getItem('sartor.key.anthropic')).toBeNull();
    expect(document.cookie).not.toContain('sk-ant');
  });

  it('never renders the key in full', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    const key = 'sk-ant-supersecretvalue-abcdefg';
    fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));

    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());
    expect(document.body.textContent).not.toContain(key);
    expect(document.body.textContent).toContain('•');
  });

  it('forgets the key on request', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/anthropic api key/i), { target: { value: 'sk-ant-x1234567890' } });
    fireEvent.click(screen.getByRole('button', { name: /use key/i }));
    await waitFor(() => expect(screen.getByText(/key loaded/i)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /forget key/i }));
    await waitFor(() => expect(sessionStorage.getItem('sartor.key.anthropic')).toBeNull());
  });

  it('lets someone build a profile by hand without an API key', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /create an empty profile/i }));
    await waitFor(() => expect(screen.getByText(/confirm before saving/i)).toBeDefined());
    expect(screen.getByRole('button', { name: /save profile and continue/i })).toBeDefined();
    // The editable form is there, so nothing has been guessed on the user's behalf.
    expect(screen.getByLabelText(/full name/i)).toBeDefined();
  });

  it('gates the later steps until there is a profile', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    expect(screen.getByRole('button', { name: /3\. review changes/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /4\. export/i })).toHaveProperty('disabled', true);
  });

  it('never strands the user on a step that has just become unavailable', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());

    // Build and save a profile, which unlocks step 2 and navigates there.
    fireEvent.click(screen.getByRole('button', { name: /create an empty profile/i }));
    await waitFor(() => expect(screen.getByLabelText(/full name/i)).toBeDefined());
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Dana Reyes' } });
    fireEvent.click(screen.getByRole('button', { name: /save profile and continue/i }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /the job posting/i })).toBeDefined());

    // Erase everything from under it. The nav disables step 2, so the app must
    // not keep rendering step 2's content.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /erase all local data/i }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /start from an existing resume/i })).toBeDefined(),
    );
    expect(screen.queryByRole('heading', { name: /the job posting/i })).toBeNull();
    expect(screen.getByRole('button', { name: /2\. job posting/i })).toHaveProperty('disabled', true);
  });

  it('states where the key goes, at the point of entry', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Sartor')).toBeDefined());
    const text = document.body.textContent ?? '';
    expect(text).toContain('sessionStorage');
    expect(text).toContain('anthropic-dangerous-direct-browser-access');
  });
});
