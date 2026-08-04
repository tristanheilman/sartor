import { describe, it, expect } from 'vitest';
import { keywordHead, splitKeywords } from './skills';

/**
 * The bug these exist for, from a real profile:
 *
 *   Firebase (Authentication, Cloud Messaging, Hosting, Firestore),
 *   AWS (Lambda, Cognito, S3, RDS, EC2, ELB, VPC, ECR, WAF, CloudWatch), GCP
 *
 * A plain `split(',')` turned that into thirteen entries, and the interview
 * dutifully asked "where have you used CloudWatch)?" — a question about a
 * fragment, with a bracket in it, that no one can answer.
 */

const REAL =
  'Firebase (Authentication, Cloud Messaging, Hosting, Firestore), AWS (Lambda, Cognito, S3, RDS, EC2, ELB, VPC, ECR, WAF, CloudWatch), GCP';

describe('splitting a skills line', () => {
  it('keeps a bracketed group together', () => {
    expect(splitKeywords(REAL)).toEqual([
      'Firebase (Authentication, Cloud Messaging, Hosting, Firestore)',
      'AWS (Lambda, Cognito, S3, RDS, EC2, ELB, VPC, ECR, WAF, CloudWatch)',
      'GCP',
    ]);
  });

  it('splits on the commas that actually separate skills', () => {
    expect(splitKeywords('Docker, JIRA, Fastlane')).toEqual(['Docker', 'JIRA', 'Fastlane']);
  });

  it('drops empty entries from trailing and doubled commas', () => {
    // Someone mid-edit types "Docker, " and every keystroke re-parses.
    expect(splitKeywords('Docker, , JIRA,')).toEqual(['Docker', 'JIRA']);
  });

  it('survives a bracket that was never closed', () => {
    // Half-typed input must not swallow the rest of the line.
    expect(splitKeywords('AWS (Lambda, S3, Docker')).toEqual(['AWS (Lambda, S3, Docker']);
  });

  it('survives a stray closing bracket', () => {
    // The reverse: a leading ")" must not make later commas look nested.
    expect(splitKeywords('S3), Docker, JIRA')).toEqual(['S3)', 'Docker', 'JIRA']);
  });

  it('handles square brackets too', () => {
    expect(splitKeywords('Testing [Jest, Detox], Docker')).toEqual(['Testing [Jest, Detox]', 'Docker']);
  });

  it('returns nothing for an empty line', () => {
    expect(splitKeywords('')).toEqual([]);
    expect(splitKeywords('   ')).toEqual([]);
  });

  it('round-trips what the editor displays', () => {
    // The field shows `keywords.join(', ')` and parses what comes back, so a
    // split that does not round-trip corrupts the profile on every keystroke.
    const once = splitKeywords(REAL);
    expect(splitKeywords(once.join(', '))).toEqual(once);
  });
});

describe('the head of a keyword', () => {
  it('takes the name before the detail in brackets', () => {
    expect(keywordHead('Firebase (Authentication, Firestore)')).toBe('Firebase');
  });

  it('takes the first of a slash-separated pair', () => {
    expect(keywordHead('Swift / Objective-C')).toBe('Swift');
  });

  it('never leaves a bracket in a question', () => {
    // "Where have you used CloudWatch)?" — the fragment that started this.
    expect(keywordHead('CloudWatch)')).toBe('CloudWatch');
    expect(keywordHead('Firestore)')).toBe('Firestore');
  });

  it('leaves a plain skill alone', () => {
    expect(keywordHead('Docker')).toBe('Docker');
  });
});
