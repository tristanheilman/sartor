import { describe, it, expect } from 'vitest';
import { parsePostingFragment, openPostingChannel } from './postingHandoff';

describe('parsePostingFragment', () => {
  const encode = (obj: unknown) => `#posting=${encodeURIComponent(JSON.stringify(obj))}`;

  it('parses a valid posting', () => {
    const jd = parsePostingFragment(
      encode({ title: 'Engineer', company: 'Acme', location: 'Remote', url: 'https://x', text: 'A role doing things.' }),
    );
    expect(jd).toEqual({
      title: 'Engineer',
      company: 'Acme',
      location: 'Remote',
      url: 'https://x',
      text: 'A role doing things.',
      source: 'extension',
    });
  });

  it('rejects malformed JSON', () => {
    expect(parsePostingFragment(`#posting=${encodeURIComponent('{not json')}`)).toBeNull();
  });

  it('rejects an oversized payload', () => {
    expect(parsePostingFragment(encode({ text: 'x'.repeat(200_000) }))).toBeNull();
  });

  it('rejects a payload missing text', () => {
    expect(parsePostingFragment(encode({ title: 'Engineer' }))).toBeNull();
  });

  it('returns null for a hash with no posting', () => {
    expect(parsePostingFragment('#other=1')).toBeNull();
  });
});

describe('openPostingChannel', () => {
  it('delivers a posting from one tab to another and acks it back', async () => {
    const sender = openPostingChannel();
    const receiver = openPostingChannel();
    try {
      const received: unknown[] = [];
      receiver.onPosting((jd) => received.push(jd));

      const jd = {
        title: '',
        company: '',
        location: '',
        url: '',
        text: 'hello',
        source: 'extension' as const,
      };
      const acked = await sender.send(jd, 500);

      expect(acked).toBe(true);
      expect(received).toEqual([jd]);
    } finally {
      sender.close();
      receiver.close();
    }
  });

  it('resolves false when nothing acks, including its own tab', async () => {
    const sender = openPostingChannel();
    try {
      const jd = {
        title: '',
        company: '',
        location: '',
        url: '',
        text: 'hello',
        source: 'extension' as const,
      };
      const acked = await sender.send(jd, 50);
      expect(acked).toBe(false);
    } finally {
      sender.close();
    }
  });
});
