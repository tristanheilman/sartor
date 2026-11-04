// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { run } from './content';

describe('content script', () => {
  it('extracts the posting from the current document', () => {
    document.body.innerHTML = `
      <article>
        <h1>Software Engineer</h1>
        <p>${'Job posting filler text that is long enough to pass the length threshold. '.repeat(10)}</p>
      </article>
    `;

    const result = run();

    expect(result).not.toBeNull();
  });
});
