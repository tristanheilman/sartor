/**
 * Reading a skills line the way a person wrote it.
 *
 * Skills arrive as one comma-separated string, and the obvious `split(',')`
 * is wrong for the way people actually group them:
 *
 *   AWS (Lambda, Cognito, S3, CloudWatch), Docker, JIRA
 *
 * Splitting that on every comma yields "AWS (Lambda", "Cognito", "S3",
 * "CloudWatch)" and "Docker" — four fragments and one real entry. The damage
 * is not cosmetic: the interview asks about each keyword with no story behind
 * it, so a mangled fragment becomes a question, and someone gets asked "where
 * have you used CloudWatch)?".
 *
 * Commas inside brackets belong to the group that opened them. Only the ones
 * at the top level separate entries.
 */
export function splitKeywords(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of input) {
    if (char === '(' || char === '[') depth++;
    // Never go negative: a stray ")" from a half-typed edit would otherwise
    // make every later comma look like it was inside a group.
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1);

    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  out.push(current.trim());
  return out.filter(Boolean);
}

/**
 * The part of a keyword worth asking about.
 *
 * "Swift / Objective-C" and "Firebase (Authentication, Firestore)" are both one
 * skill written with its detail attached; the head is the thing itself. An
 * unbalanced bracket left over from an edit must not survive into a question.
 */
export function keywordHead(keyword: string): string {
  return (keyword.split(/[(/,[]/)[0] ?? keyword).replace(/[)\]]/g, '').trim();
}
