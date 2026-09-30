import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

/** Bind replay evidence to all production libraries and locked JS dependencies.
 * Test-only changes do not invalidate a conversion record. */
export function conversionFingerprint() {
  const root = new URL('../lib/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .map((name) => name.toString())
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256').update('brickform-conversion-v2\0');
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(new URL(file, root)))
      .update('\0');
  hash.update(readFileSync(new URL('../package-lock.json', import.meta.url)));
  return hash.digest('hex');
}
