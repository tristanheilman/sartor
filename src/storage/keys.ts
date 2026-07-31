/**
 * API key handling.
 *
 * The key lives in `sessionStorage` and nowhere else. That means:
 *
 *   - it is scoped to this tab, and is gone when the tab closes;
 *   - it is never written to IndexedDB, localStorage, a cookie, or disk;
 *   - it is never sent anywhere except the provider's own endpoint.
 *
 * `sessionStorage` is readable by any script running on this origin, which is
 * the unavoidable cost of a zero-backend design. The mitigation is that the
 * application ships no third-party scripts and no analytics, so the only code
 * on the page is code in this repository.
 */

const KEY_PREFIX = 'sartor.key.';

export function keyStorageKey(providerId: string): string {
  return `${KEY_PREFIX}${providerId}`;
}

export function getApiKey(providerId: string): string | null {
  try {
    return sessionStorage.getItem(keyStorageKey(providerId));
  } catch {
    return null; // Private mode or storage disabled.
  }
}

export function setApiKey(providerId: string, key: string): void {
  sessionStorage.setItem(keyStorageKey(providerId), key.trim());
}

export function clearApiKey(providerId: string): void {
  sessionStorage.removeItem(keyStorageKey(providerId));
}

export function clearAllApiKeys(): void {
  for (const k of Object.keys(sessionStorage)) {
    if (k.startsWith(KEY_PREFIX)) sessionStorage.removeItem(k);
  }
}

/** Masked form for display. Never render a key in full. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 7)}${'•'.repeat(12)}${key.slice(-4)}`;
}
