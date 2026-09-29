/**
 * Matches a schema artefact's `generates` pattern against relative artefact
 * paths, the way `resolveArtifactOutputs` matches it against files with
 * fast-glob: `**` spans directories (including none), `*` and `?` stay within
 * one segment. This is what a store without files uses to say which outputs
 * exist; the file store keeps the real glob.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

export function generatesMatcher(pattern: string): (relativePath: string) => boolean {
  const normalized = pattern.split('\\').join('/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        // `**/` matches zero or more whole segments; a bare `**` matches anything.
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(SPECIAL, '\\$&');
    }
  }
  const regex = new RegExp(`^${source}$`);
  return (relativePath) => regex.test(relativePath.split('\\').join('/'));
}

/** The outputs, among those a change holds, that a `generates` pattern names, sorted. */
export function matchOutputs(outputs: Iterable<string>, generates: string): string[] {
  const matches = generatesMatcher(generates);
  return [...outputs].filter((output) => matches(output)).sort();
}
