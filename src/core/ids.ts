/** Short, stable, collision-resistant IDs. Prefixed so a loose ID in a log or
 * an LLM response is self-describing. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

export const ids = {
  profile: () => newId('prf'),
  work: () => newId('wrk'),
  education: () => newId('edu'),
  project: () => newId('prj'),
  skill: () => newId('skl'),
  cert: () => newId('crt'),
  award: () => newId('awd'),
  language: () => newId('lng'),
  bullet: () => newId('blt'),
  variant: () => newId('var'),
  run: () => newId('run'),
  change: () => newId('chg'),
};
